/**
 * A simulated LinkedIn for tests and the engine simulation (the fake driver's world). It is the
 * ground truth: it keeps members, connections, invitations, conversations and an append-only log
 * of everything LinkedIn received or showed. It lives in memory and outlives any number of driver
 * handles, so a "killed" process leaves it exactly as the real site would be.
 *
 * Time is whatever the handles' clocks say. Members act lazily: every driver call first settles
 * the world up to `clock.now()`, so acceptances, replies and the user's own messages appear with
 * their own timestamps. Call `settle` before asserting on what happened by a given time.
 *
 * It is not kinder than the real site: texts come back the way LinkedIn stores them, message times
 * are day headings with no exact time except for earlier years, older connections fall off the
 * connections page, and a conversation with someone who is not a connection cannot be opened.
 */
import type { InviteResult, ReadThreadResult, SearchQuery, WithdrawResult } from "../driver";
import { Checkpoint, LimitHit, LoggedOut, Restricted, Unexpected, type LinkedInError } from "../errors";
import { profileUrlFor, type Card } from "../parse/card";
import type { ConnectionCard } from "../parse/connections";
import type { ConnectionState, Profile } from "../parse/profile";
import type { RecommendationCard, RecommendationsResult } from "../parse/recommendations";
import type { SearchAction, SearchCard, SearchResults } from "../parse/search";
import type { SentInvitationCard } from "../parse/sentInvitations";
import type { Message, Sender } from "../parse/thread";
import type { PageClassification } from "../session";
import {
  createFakeDriver,
  type ConnectOptions,
  type DriverHandle,
  type DriverOp,
  type FakeLinkedIn,
  type FaultKind,
} from "./driver";

export type { ConnectOptions, DriverHandle, DriverOp, FaultKind, KillHook, KillPhase, KillPoint } from "./driver";
export { HandleRevoked } from "./driver";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const NOTE_LIMIT = 300;
const CONNECTIONS_PAGE = 40;
const SENT_INVITATIONS_PAGE = 50;
const THREAD_WINDOW = 20;
const SEARCH_PAGE_SIZE = 10;
const MEMBER_ID = /^ACoA[A-Za-z0-9_-]+$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface WorldOptions {
  /** When the world begins: the default date of connections and outside invitations that exist from the start. */
  readonly start: Date;
  /** The signed-in user's name, as senderName on his messages. Default "Test User". */
  readonly userName?: string;
  /** An accepted invitation's note shows as the user's first message in the conversation. Default true. */
  readonly notesAsFirstMessage?: boolean;
  /** A space before `?`, `!` or `:` is stored as a non-breaking space. Default true. */
  readonly nbspBeforePunctuation?: boolean;
  /** Invitations LinkedIn accepts in any 7 days; over it `sendInvite` throws `LimitHit`. Default none. */
  readonly weeklyInviteCap?: number | null;
}

/** A member as the test adds them, with the script of what they (and the user, by hand) will do. */
export interface MemberSpec {
  readonly publicId: string;
  /** `ACoA…`, the id the messaging pages use. */
  readonly memberId: string;
  readonly fullName: string;
  readonly headline?: string | null;
  readonly location?: string | null;
  readonly currentTitle?: string | null;
  readonly currentCompany?: string | null;
  readonly degree: 1 | 2 | 3;
  /** For a 1st-degree member: when they connected. Default: the world's start. */
  readonly connectedAt?: Date;
  /** For `invitedOutsideApp`: when that invitation was sent. Default: the world's start. */
  readonly invitedAt?: Date;
  /** Hours after a pending invitation was sent at which they accept. Null or absent: never. */
  readonly acceptsAfterHours?: number | null;
  /** Hours after the app's first message at which they reply. */
  readonly repliesAfterHours?: number | null;
  /** Hours after connecting at which they write first, if the app has not messaged them by then. */
  readonly repliesBeforeFirstMessageAfterHours?: number | null;
  /** Hours after connecting at which the user messages them himself, by hand (manual takeover). */
  readonly userWritesAfterHours?: number | null;
  /** Hours after the app's first message at which the user re-sends, by hand, the app's latest message word for word. */
  readonly userResendsAfterHours?: number | null;
  /** What they write. Default "Hi, this is <full name>. Happy to talk." */
  readonly replyText?: string;
  /** What the user writes by hand. Default "Hi <full name>, writing to you myself." */
  readonly userText?: string;
  /** The profile offers Follow only: no Connect anywhere. */
  readonly connectUnavailable?: boolean;
  /** An invitation the user sent outside the app is already pending. */
  readonly invitedOutsideApp?: boolean;
  /** Connect is in the More menu. */
  readonly connectInMore?: boolean;
}

/** Where a message came from: the app's `sendMessage`, an accepted invitation's note, the user by hand, or the member. */
export type WorldMessageSource = "app" | "note" | "manual" | "member";

export interface WorldMessage {
  readonly sender: Sender;
  readonly source: WorldMessageSource;
  /** As LinkedIn stores it. */
  readonly text: string;
  readonly at: Date;
}

export type LogKind = "invite" | "message" | "withdraw" | "profile_view" | "thread_read" | "page_load";

/** Which page a `page_load` was. */
export type FakePage = "feed" | "search" | "recommendations" | "connections" | "sent_invitations" | "profile" | "messaging";

/** One thing LinkedIn received or showed, at world time. */
export interface LogEntry {
  readonly kind: LogKind;
  readonly publicId?: string;
  readonly memberId?: string;
  /** For `message`: the text as the app typed it. */
  readonly text?: string;
  /** For `invite`: the note, when one was sent. */
  readonly note?: string;
  readonly page?: FakePage;
  readonly at: Date;
}

export type SessionBreak = "logged_out" | "checkpoint" | "restricted";

export interface MemberStatus {
  readonly degree: 1 | 2 | 3;
  readonly connectedAt: Date | null;
  /** When the pending invitation was sent; null when none is pending. */
  readonly pendingSince: Date | null;
}

export interface RecommendationGroupSpec {
  readonly title: string;
  readonly publicIds: readonly string[];
}

type ScriptedEvent = "replyBefore" | "userWrites" | "reply" | "resend";

interface Member {
  readonly spec: MemberSpec;
  degree: 1 | 2 | 3;
  connectedAt: Date | null;
  invite: { readonly sentAt: Date; readonly note: string | null } | null;
  readonly thread: WorldMessage[];
  draft: string | null;
  firstAppMessageAt: Date | null;
  readonly fired: Set<ScriptedEvent>;
}

interface Due {
  readonly at: number;
  run(): void;
}

export class FakeWorld {
  readonly #options: Required<WorldOptions>;
  readonly #members = new Map<string, Member>();
  readonly #byMemberId = new Map<string, Member>();
  readonly #log: LogEntry[] = [];
  readonly #faults = new Map<DriverOp, FaultKind[]>();
  readonly #searches = new Map<string, readonly string[]>();
  #recommendations: readonly RecommendationGroupSpec[] = [];
  #session: SessionBreak | "ok" = "ok";
  readonly #port: FakeLinkedIn;

  constructor(options: WorldOptions) {
    this.#options = {
      userName: "Test User",
      notesAsFirstMessage: true,
      nbspBeforePunctuation: true,
      weeklyInviteCap: null,
      ...options,
    };
    this.#port = this.#createPort();
  }

  // ---- setup ----

  addMember(spec: MemberSpec): void {
    if (!MEMBER_ID.test(spec.memberId)) throw new RangeError(`not a member id: ${spec.memberId}`);
    if (this.#members.has(spec.publicId)) throw new RangeError(`duplicate public id: ${spec.publicId}`);
    if (this.#byMemberId.has(spec.memberId)) throw new RangeError(`duplicate member id: ${spec.memberId}`);
    if (spec.degree === 1 && spec.invitedOutsideApp === true) throw new RangeError("a connection cannot have a pending invitation");
    const member: Member = {
      spec,
      degree: spec.degree,
      connectedAt: spec.degree === 1 ? new Date(spec.connectedAt ?? this.#options.start) : null,
      invite: spec.invitedOutsideApp === true ? { sentAt: new Date(spec.invitedAt ?? this.#options.start), note: null } : null,
      thread: [],
      draft: null,
      firstAppMessageAt: null,
      fired: new Set(),
    };
    this.#members.set(spec.publicId, member);
    this.#byMemberId.set(spec.memberId, member);
  }

  /** What a search for `query` (its keywords, or its URL) returns, `SEARCH_PAGE_SIZE` per page. */
  setSearchResults(query: string, publicIds: readonly string[]): void {
    publicIds.forEach((id) => this.#member(id));
    this.#searches.set(query, [...publicIds]);
  }

  /** The groups My Network → Grow shows. 1st-degree members are never shown. */
  setRecommendations(groups: readonly RecommendationGroupSpec[]): void {
    groups.forEach((group) => group.publicIds.forEach((id) => this.#member(id)));
    this.#recommendations = groups.map((group) => ({ title: group.title, publicIds: [...group.publicIds] }));
  }

  /** Every driver call throws the matching typed error until `fixSession`. */
  breakSession(kind: SessionBreak): void {
    this.#session = kind;
  }

  fixSession(): void {
    this.#session = "ok";
  }

  /** Queues a fault for the next call of `op`, on any handle. Faults queue in order. */
  failNext(op: DriverOp, fault: FaultKind): void {
    this.#faults.set(op, [...(this.#faults.get(op) ?? []), fault]);
  }

  /** A new driver handle: a new process. It starts with no latched safety stop. */
  connect(options: ConnectOptions): DriverHandle {
    return createFakeDriver(this.#port, options);
  }

  // ---- ground truth ----

  /** Makes everything scripted to happen up to `now` visible. Driver calls do this themselves. */
  settle(now: Date): void {
    const limit = now.getTime();
    for (;;) {
      let next: Due | undefined;
      for (const member of this.#members.values()) {
        for (const due of this.#dueEvents(member)) {
          if (due.at <= limit && (next === undefined || due.at < next.at)) next = due;
        }
      }
      if (next === undefined) return;
      next.run();
    }
  }

  /** Everything LinkedIn received or showed, oldest first. */
  get log(): readonly LogEntry[] {
    return [...this.#log];
  }

  /** The invitations sent to a member, as logged. */
  invitesTo(publicId: string): readonly LogEntry[] {
    return this.#log.filter((entry) => entry.kind === "invite" && entry.publicId === publicId);
  }

  /** The messages the app sent to a member (not the note, not the user's own), as logged. */
  messagesSentTo(publicId: string): readonly LogEntry[] {
    return this.#log.filter((entry) => entry.kind === "message" && entry.publicId === publicId);
  }

  /** The whole conversation with a member as settled so far, oldest first, with where each message came from. */
  thread(publicId: string): readonly WorldMessage[] {
    return [...this.#member(publicId).thread];
  }

  /** What sits unsent in the member's message box. */
  draft(publicId: string): string | null {
    return this.#member(publicId).draft;
  }

  status(publicId: string): MemberStatus {
    const member = this.#member(publicId);
    return { degree: member.degree, connectedAt: member.connectedAt, pendingSince: member.invite?.sentAt ?? null };
  }

  /** A text as LinkedIn stores and shows it. */
  stored(text: string): string {
    const lines = text.replace(/\r\n/g, "\n").trim().replace(/\n{3,}/g, "\n\n");
    return this.#options.nbspBeforePunctuation ? lines.replace(/ ([?!:])/g, " $1") : lines;
  }

  // ---- internals ----

  #member(publicId: string): Member {
    const member = this.#members.get(publicId);
    if (member === undefined) throw new RangeError(`no member ${publicId} in the world`);
    return member;
  }

  #record(entry: LogEntry): void {
    this.#log.push(Object.freeze({ ...entry, at: new Date(entry.at) }));
  }

  /** Adds a message to the conversation, its text as LinkedIn stores it. */
  #post(member: Member, message: WorldMessage): void {
    const stored: WorldMessage = Object.freeze({ ...message, text: this.stored(message.text), at: new Date(message.at) });
    // Keep time order even if two handles' clocks disagree.
    let index = member.thread.length;
    while (index > 0 && (member.thread[index - 1]?.at.getTime() ?? 0) > stored.at.getTime()) index -= 1;
    member.thread.splice(index, 0, stored);
  }

  #dueEvents(member: Member): Due[] {
    const { spec } = member;
    const events: Due[] = [];
    const after = (base: Date, hours: number) => base.getTime() + hours * HOUR_MS;
    const once = (event: ScriptedEvent, at: number, act: () => void): void => {
      if (member.fired.has(event)) return;
      events.push({
        at,
        run: () => {
          member.fired.add(event);
          act();
        },
      });
    };

    const invite = member.invite;
    const accepts = spec.acceptsAfterHours ?? null;
    if (invite !== null && accepts !== null && member.degree !== 1) {
      const at = after(invite.sentAt, accepts);
      events.push({ at, run: () => this.#accept(member, new Date(at)) });
    }
    if (member.connectedAt !== null) {
      const before = spec.repliesBeforeFirstMessageAfterHours ?? null;
      if (before !== null) {
        const at = after(member.connectedAt, before);
        once("replyBefore", at, () => {
          if (member.firstAppMessageAt === null) this.#post(member, { sender: "participant", source: "member", text: replyText(spec), at: new Date(at) });
        });
      }
      const writes = spec.userWritesAfterHours ?? null;
      if (writes !== null) {
        const at = after(member.connectedAt, writes);
        once("userWrites", at, () => this.#post(member, { sender: "user", source: "manual", text: userText(spec), at: new Date(at) }));
      }
    }
    if (member.firstAppMessageAt !== null) {
      const replies = spec.repliesAfterHours ?? null;
      if (replies !== null) {
        const at = after(member.firstAppMessageAt, replies);
        once("reply", at, () => this.#post(member, { sender: "participant", source: "member", text: replyText(spec), at: new Date(at) }));
      }
      const resends = spec.userResendsAfterHours ?? null;
      if (resends !== null) {
        const at = after(member.firstAppMessageAt, resends);
        once("resend", at, () => {
          const last = member.thread.findLast((message) => message.source === "app");
          if (last !== undefined) this.#post(member, { sender: "user", source: "manual", text: last.text, at: new Date(at) });
        });
      }
    }
    return events;
  }

  #accept(member: Member, at: Date): void {
    const note = member.invite?.note ?? null;
    member.invite = null;
    member.degree = 1;
    member.connectedAt = at;
    if (note !== null && this.#options.notesAsFirstMessage && this.stored(note) !== "") {
      this.#post(member, { sender: "user", source: "note", text: note, at });
    }
  }

  #pageLoad(page: FakePage, now: Date, member?: Member): void {
    this.#record({ kind: "page_load", page, at: now, ...(member === undefined ? {} : ids(member)) });
  }

  /** The member a profile URL opens; an unknown one is LinkedIn's "profile not available" page. */
  #profileTarget(publicId: string, now: Date): Member {
    const member = this.#members.get(publicId);
    if (member === undefined) {
      this.#record({ kind: "page_load", page: "profile", publicId, at: now });
      throw new Unexpected(`fake world: no profile ${publicId}`);
    }
    return member;
  }

  /** The member a compose URL opens; anyone but a connection gets an InMail form (decision 17). */
  #conversationTarget(memberId: string, now: Date): Member {
    const member = this.#byMemberId.get(memberId);
    if (member === undefined || member.degree !== 1) {
      this.#record({ kind: "page_load", page: "messaging", memberId, at: now, ...(member === undefined ? {} : ids(member)) });
      throw new Unexpected(`fake world: ${memberId} is not a connection; the page is an InMail form`);
    }
    return member;
  }

  #connectionState(member: Member): ConnectionState {
    if (member.degree === 1) return "connected";
    if (member.invite !== null) return "pending";
    if (member.spec.connectUnavailable === true) return "follow_only";
    if (member.spec.connectInMore === true) return "connect_in_more";
    return "can_connect";
  }

  #card(member: Member): Card {
    const { spec } = member;
    return {
      publicId: spec.publicId,
      profileUrl: profileUrlFor(spec.publicId),
      fullName: spec.fullName,
      headline: spec.headline ?? null,
      location: spec.location ?? null,
      company: spec.currentCompany ?? null,
      degree: member.degree,
    };
  }

  #action(member: Member): SearchAction {
    if (member.degree === 1) return "message";
    if (member.invite !== null) return "pending";
    if (member.spec.connectUnavailable === true) return "follow";
    return "connect";
  }

  #createPort(): FakeLinkedIn {
    return {
      settle: (now) => this.settle(now),

      sessionError: (op, now): LinkedInError | null => {
        const state = this.#session;
        if (state === "ok") return null;
        this.#record({ kind: "page_load", at: now });
        const message = `fake world: ${state} on ${op}`;
        switch (state) {
          case "logged_out":
            return new LoggedOut(message);
          case "checkpoint":
            return new Checkpoint(message);
          case "restricted":
            return new Restricted(message);
          default: {
            const _exhaustive: never = state;
            return _exhaustive;
          }
        }
      },

      takeFault: (op) => this.#faults.get(op)?.shift(),

      ensureSession: (now): PageClassification => {
        this.#pageLoad("feed", now);
        return { state: "ok", evidence: "fake world: signed in" };
      },

      searchPeople: (query: SearchQuery, now): SearchResults => {
        this.#pageLoad("search", now);
        const ids = this.#searches.get("url" in query ? query.url : query.keywords) ?? [];
        const page = query.page ?? 1;
        if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a whole number from 1");
        const cards: SearchCard[] = ids
          .slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE)
          .map((id) => this.#member(id))
          .map((member) => ({ ...this.#card(member), action: this.#action(member), summary: null }));
        return { cards, hasNextPage: page * SEARCH_PAGE_SIZE < ids.length, capped: false, hiddenMembers: 0 };
      },

      listRecommendations: (now): RecommendationsResult => {
        this.#pageLoad("recommendations", now);
        return {
          groups: this.#recommendations.map((group) => ({
            kind: "people" as const,
            title: group.title,
            reason: null,
            hasShowAll: false,
            cards: group.publicIds
              .map((id) => this.#member(id))
              .filter((member) => member.degree !== 1)
              .map((member): RecommendationCard => {
                const action = this.#action(member);
                return { ...this.#card(member), group: group.title, insight: null, action: action === "message" ? "connect" : action };
              }),
          })),
        };
      },

      viewProfile: (publicId, now): Profile => {
        const member = this.#profileTarget(publicId, now);
        this.#record({ kind: "profile_view", ...ids(member), at: now });
        const { spec } = member;
        const title = spec.currentTitle ?? null;
        const company = spec.currentCompany ?? null;
        return {
          publicId: spec.publicId,
          profileUrl: profileUrlFor(spec.publicId),
          fullName: spec.fullName,
          headline: spec.headline ?? null,
          location: spec.location ?? null,
          degree: member.degree,
          about: null,
          currentTitle: title,
          currentCompany: title === null ? null : company,
          experience:
            title === null ? [] : [{ title, company, dateRange: null, current: true, location: null, description: null }],
          connectionState: this.#connectionState(member),
          messageAvailable: member.degree === 1,
          memberId: spec.memberId,
        };
      },

      listRecentConnections: (now): ConnectionCard[] => {
        this.#pageLoad("connections", now);
        return [...this.#members.values()]
          .filter((member) => member.degree === 1 && member.connectedAt !== null)
          .sort((a, b) => (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0))
          .slice(0, CONNECTIONS_PAGE)
          .map((member): ConnectionCard => {
            const on = member.connectedAt ?? now;
            return {
              ...this.#card(member),
              location: null,
              company: null,
              degree: 1,
              connectedOnText: `Connected on ${MONTHS[on.getUTCMonth()] ?? ""} ${on.getUTCDate()}, ${on.getUTCFullYear()}`,
              connectedOn: on.toISOString().slice(0, 10),
              memberId: member.spec.memberId,
            };
          });
      },

      listSentInvitations: (now): SentInvitationCard[] => {
        this.#pageLoad("sent_invitations", now);
        return [...this.#members.values()]
          .flatMap((member) => (member.invite === null ? [] : [{ member, sentAt: member.invite.sentAt }]))
          .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
          .slice(0, SENT_INVITATIONS_PAGE)
          .map(({ member, sentAt }) => ({
            ...this.#card(member),
            location: null,
            company: null,
            degree: null,
            sentText: sentAgo(sentAt, now),
            canWithdraw: true,
          }));
      },

      readThread: ({ memberId, publicId }, now): ReadThreadResult => {
        if (!/^[A-Za-z0-9_-]+$/.test(memberId)) throw new RangeError("not a member id");
        const member = this.#conversationTarget(memberId, now);
        const { spec } = member;
        const isNew = member.thread.length === 0;
        // The live driver cannot tell an empty pane is this person's unless the vanity id matches.
        if (isNew && publicId !== spec.publicId) {
          throw new Unexpected("fake world: the new-message pane names someone other than the person asked for");
        }
        this.#record({ kind: "thread_read", ...ids(member), at: now });
        const hasWritten = member.thread.some((message) => message.sender === "participant");
        const shownId = hasWritten ? spec.memberId : isNew ? spec.publicId : null;
        const messages = member.thread.slice(-THREAD_WINDOW).map((message): Message => {
          const { raw, exact } = shownTime(message.at, now);
          return {
            sender: message.sender,
            senderName: message.sender === "user" ? this.#options.userName : spec.fullName,
            subject: null,
            text: message.text,
            sentAtRaw: raw,
            sentAt: exact,
          };
        });
        return {
          participant: {
            fullName: spec.fullName,
            headline: spec.headline ?? null,
            publicId: shownId,
            profileUrl: shownId === null ? null : profileUrlFor(shownId),
          },
          kind: "message",
          messages,
          isNew,
          viaCompose: true,
          threadUrl: null,
        };
      },

      sendInvite: (person, note, now): InviteResult => {
        const member = this.#profileTarget(person.publicId, now);
        if (note !== null && note.length > NOTE_LIMIT) {
          this.#pageLoad("profile", now, member);
          throw new Unexpected(`fake world: a note of ${note.length} characters does not fit LinkedIn's ${NOTE_LIMIT}`);
        }
        const refusal = this.#inviteRefusal(member);
        if (refusal !== null) {
          this.#pageLoad("profile", now, member);
          return refusal;
        }
        const cap = this.#options.weeklyInviteCap;
        const since = now.getTime() - WEEK_MS;
        if (cap !== null && this.#log.filter((entry) => entry.kind === "invite" && entry.at.getTime() > since).length >= cap) {
          this.#pageLoad("profile", now, member);
          throw new LimitHit("fake world: weekly invitation limit reached");
        }
        member.invite = { sentAt: new Date(now), note };
        this.#record({ kind: "invite", ...ids(member), ...(note === null ? {} : { note }), at: now });
        return "sent";
      },

      typeMessage: (person, text, now) => {
        const member = this.#conversationTarget(person.memberId, now);
        this.#pageLoad("messaging", now, member);
        if (this.stored(text) === "") throw new Unexpected("fake world: an empty message cannot be sent");
        // The box is cleared, then the text typed: what `sendTyped` sends is exactly this text.
        member.draft = text;
      },

      sendTyped: (person, now) => {
        const member = this.#byMemberId.get(person.memberId);
        if (member === undefined) throw new Unexpected(`fake world: no member ${person.memberId}`);
        const text = member.draft;
        if (text === null) throw new Unexpected("fake world: the message box is empty");
        member.draft = null;
        this.#post(member, { sender: "user", source: "app", text, at: now });
        member.firstAppMessageAt ??= new Date(now);
        this.#record({ kind: "message", ...ids(member), text, at: now });
      },

      withdrawInvite: (person, now): WithdrawResult => {
        const member = this.#profileTarget(person.publicId, now);
        if (member.invite === null) {
          this.#pageLoad("sent_invitations", now, member);
          return "not_pending";
        }
        member.invite = null;
        this.#record({ kind: "withdraw", ...ids(member), at: now });
        return "withdrawn";
      },
    };
  }

  #inviteRefusal(member: Member): Exclude<InviteResult, "sent"> | null {
    if (member.degree === 1) return "already_connected";
    if (member.invite !== null) return "already_pending";
    if (member.spec.connectUnavailable === true) return "not_offered";
    return null;
  }
}

function ids(member: Member): { publicId: string; memberId: string } {
  return { publicId: member.spec.publicId, memberId: member.spec.memberId };
}

function replyText(spec: MemberSpec): string {
  return spec.replyText ?? `Hi, this is ${spec.fullName}. Happy to talk.`;
}

function userText(spec: MemberSpec): string {
  return spec.userText ?? `Hi ${spec.fullName}, writing to you myself.`;
}

/** "Sent today", "Sent 3 days ago", "Sent 2 weeks ago", "Sent 1 month ago". */
function sentAgo(sentAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - sentAt.getTime()) / DAY_MS);
  const ago = (count: number, unit: string) => `Sent ${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (days < 1) return "Sent today";
  if (days < 7) return ago(days, "day");
  if (days < 30) return ago(Math.floor(days / 7), "week");
  return ago(Math.floor(days / 30), "month");
}

/**
 * A message time as the messaging page shows it (UTC): "Today 1:29 PM", "Yesterday …", a weekday
 * within the week, "Mar 3 …" this year, "Mar 3, 2025 …" before. Only the last carries a year, so
 * only it gives an exact time, to the minute, as the live parser does.
 */
function shownTime(at: Date, now: Date): { raw: string; exact: Date | null } {
  const hours = at.getUTCHours();
  const time = `${((hours + 11) % 12) + 1}:${String(at.getUTCMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
  const daysAgo = Math.floor(now.getTime() / DAY_MS) - Math.floor(at.getTime() / DAY_MS);
  const month = (MONTHS[at.getUTCMonth()] ?? "").slice(0, 3);
  if (daysAgo <= 0) return { raw: `Today ${time}`, exact: null };
  if (daysAgo === 1) return { raw: `Yesterday ${time}`, exact: null };
  if (daysAgo < 7) return { raw: `${WEEKDAYS[at.getUTCDay()] ?? ""} ${time}`, exact: null };
  if (at.getUTCFullYear() === now.getUTCFullYear()) return { raw: `${month} ${at.getUTCDate()} ${time}`, exact: null };
  return {
    raw: `${month} ${at.getUTCDate()}, ${at.getUTCFullYear()} ${time}`,
    exact: new Date(Math.floor(at.getTime() / 60_000) * 60_000),
  };
}
