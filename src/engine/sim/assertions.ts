/**
 * The simulation's verdicts (handoff section 5, item 2). Assertions 1–6 read only the world: its
 * append-only log and its conversations, which are what LinkedIn received. Assertion 7 counts what
 * ran, checks the scripted members' paths and "nothing silently stuck"; it may read the app's
 * database for what only the app knows (acceptances observed, stops, holds, ledger rows).
 * Assertion 8 compares the ledger with the world.
 *
 * Limits are recomputed here from the world's log, not asked of the engine: the warm-up allowance
 * included (the engine's `inviteAllowance` appears only as a cross-check in violation details).
 * Each action is judged by the settings in force when it happened (`ScenarioFacts.settingsHistory`):
 * a limit the user lowers mid-day holds from that moment.
 * Assertions 3, 6 and 7 also read the harness's records: calls the laptop slept through, kills,
 * interventions and send calls.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Settings } from "../../config/settings";
import { openDb, type Db } from "../../db/index";
import { actions, campaigns, people, prospects, safetyStops } from "../../db/schema";
import type { LogEntry, LogKind, WorldMessage } from "../../linkedin/fake/world";
import { inviteAllowance } from "../budget";
import type { CampaignFact, Expectation, MemberFact, MinimumKey, ProspectFact, SimRun, Suspension, WriteOp } from "./harness";
import { isWriteOp, MINIMUM_KEYS, settingsAt } from "./harness";
import {
  addDays,
  firstWorkingDayFrom,
  inWorkingWindow,
  lastWorkingDaysBefore,
  localDay,
  localInstant,
  localWeek,
  windowOn,
} from "./localTime";
import { breakRuns, samePiece } from "./pieces";

export interface Violation {
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

/** How many things an assertion looked at, e.g. `{ count: 112, what: "invites and messages" }`. */
export interface Checked {
  readonly count: number;
  readonly what: string;
}

export interface AssertionResult {
  /** 0 is the harness itself; 1–6 the handoff's assertions; 7 and 8 the simulation's own. */
  readonly id: number;
  readonly title: string;
  readonly violations: Violation[];
  /** Numbers worth printing whether or not anything failed. */
  readonly notes: string[];
  readonly checked: readonly Checked[];
}

export interface DayUsage {
  readonly day: string;
  readonly invites: number;
  readonly allowance: number;
  readonly messages: number;
  readonly profileViews: number;
  readonly withdrawals: number;
  readonly discoveryPages: number;
}

/** Counts reported beside the minimums, with no minimum of their own. */
export const EXTRA_COUNT_KEYS = [
  "engineErrors",
  "downtimeRestarts",
  "reconcileHeld",
  "reconcileNotRetried",
  "safetyStopOther",
  "ticks",
  "ticksWithWork",
  "kills",
  "suspendedReadsRandom",
  "suspendedSendsRandom",
  "longestRunWithoutBreak",
] as const;
export type CountKey = MinimumKey | (typeof EXTRA_COUNT_KEYS)[number];

export interface Verdict {
  readonly seed: number;
  readonly results: readonly AssertionResult[];
  readonly counts: Readonly<Record<CountKey, number>>;
  readonly daysAfterDowntime: readonly DayAfterDowntime[];
  readonly wallMs: number;
}

export interface DayAfterDowntime extends DayUsage {
  /** "<from> → <to>", ISO instants. */
  readonly downtime: string;
  readonly messageLimit: number;
  /** The laptop was on before the window opened: the whole working day was there to fill. */
  readonly full: boolean;
  /** The app's claims that day (as its budgets count them) reached the day's invite allowance or message limit. */
  readonly atLimit: boolean;
}

/** Starts the note of assertion 6 that says what a "normal day" is checked as. */
export const NORMAL_DAY_NOTE = "a normal day is checked as: ";

/** What each limited kind of log entry counts against. */
type Counted = "invites" | "messages" | "profileViews" | "withdrawals" | "discoveryPages";

const DAY_LIMIT: Readonly<Record<Exclude<Counted, "invites">, keyof Settings["limits"]>> = {
  messages: "messagesPerDay",
  profileViews: "profileViewsPerDay",
  withdrawals: "withdrawalsPerDay",
  discoveryPages: "discoveryPagesPerDay",
};

const COUNTED_WORDS: Readonly<Record<Counted, string>> = {
  invites: "invites",
  messages: "messages",
  profileViews: "profile views",
  withdrawals: "withdrawals",
  discoveryPages: "discovery pages",
};

function countedAs(entry: LogEntry): Counted | null {
  if (entry.kind === "invite") return "invites";
  if (entry.kind === "message") return "messages";
  if (entry.kind === "withdraw") return "withdrawals";
  // A profile that failed to open was still a profile page load.
  if (entry.kind === "profile_view" || (entry.kind === "page_load" && entry.page === "profile" && entry.memberId === undefined)) return "profileViews";
  if (entry.kind === "page_load" && (entry.page === "search" || entry.page === "recommendations")) return "discoveryPages";
  return null;
}

const WRITE_KIND: Readonly<Record<WriteOp, LogKind>> = { sendInvite: "invite", sendMessage: "message", withdrawInvite: "withdraw" };
const WRITE_WORDS: Readonly<Record<WriteOp, string>> = { sendInvite: "invite", sendMessage: "message", withdrawInvite: "withdrawal" };
/** A planned send sleep must start at most this long before the window's end. */
const SLEEP_STARTS_WITHIN_MS = 15 * 60_000;

export function violationCount(verdict: Verdict): number {
  return verdict.results.reduce((sum, result) => sum + result.violations.length, 0);
}

const SEND_KINDS = new Set<LogEntry["kind"]>(["invite", "message", "withdraw"]);
/** Ledger rows of a step; every other row is a read (or a check) and is never left unknown. */
const STEP_KEY = /^(invite|message1|followup|withdraw):/;
/** A title taken for a first name, a greeting with no name after it, or a placeholder left in. */
const UNNAMED_TEXT = /\bDott\.|\b(?:Hi|Hello|Dear|Ciao)\s*[,.!?]|\{\{/;
/** Claims of one step the app may make before it holds the prospect for review. */
const MAX_SEND_ATTEMPTS = 3;
const READ_KINDS: ReadonlySet<LogEntry["kind"]> = new Set(["profile_view", "thread_read", "page_load"]);

// ---------------------------------------------------------------- template rendering, independently

type Rendered = { readonly kind: "none" } | { readonly kind: "unresolvable" } | { readonly kind: "text"; readonly text: string };

function render(template: string | null, prospect: ProspectFact): Rendered {
  if (template === null || template.trim() === "") return { kind: "none" };
  const values: Readonly<Record<string, string | null>> = { first_name: prospect.firstName, company: prospect.company };
  let unresolved = false;
  const text = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, name: string) => {
    const value = values[name] ?? null;
    if (value === null || value.trim() === "") {
      unresolved = true;
      return "";
    }
    return value;
  });
  return unresolved ? { kind: "unresolvable" } : { kind: "text", text: text.trim() };
}

function iso(at: Date): string {
  return at.toISOString();
}

function entryLabel(entry: LogEntry): string {
  const who = entry.publicId ?? entry.memberId ?? "-";
  return `${iso(entry.at)} ${entry.kind}${entry.page === undefined ? "" : `(${entry.page})`} ${who}`;
}

// ---------------------------------------------------------------- the judge

export function judge(run: SimRun): Verdict {
  const { world, scenario } = run;
  const { facts } = scenario;
  /** The settings now; the window, time zone, gaps and breaks never change in a scenario. */
  const settings = facts.settings;
  const tz = settings.timeZone;
  const at = (moment: Date): Settings => settingsAt(facts, moment);
  /** The settings in force at the end of a local day's window. */
  const onDay = (key: string): Settings => at(new Date(windowOn(settings, key).end.getTime() - 1));
  world.settle(run.finishedAt);
  const log = world.log;
  const memberFor = (entry: LogEntry): MemberFact | undefined =>
    (entry.publicId === undefined ? undefined : facts.members.get(entry.publicId)) ??
    [...facts.members.values()].find((member) => member.memberId === entry.memberId);

  // ---- usage per local day and week, from the world's log
  type Used = Record<Counted, number>;
  const none = (): Used => ({ invites: 0, messages: 0, profileViews: 0, withdrawals: 0, discoveryPages: 0 });
  const usage = new Map<string, Used>();
  const weekInvites = new Map<string, number>();
  for (const entry of log) {
    const counted = countedAs(entry);
    if (counted === null) continue;
    const key = localDay(tz, entry.at);
    const today = usage.get(key) ?? none();
    usage.set(key, today);
    today[counted] += 1;
    if (counted === "invites") weekInvites.set(localWeek(tz, entry.at), (weekInvites.get(localWeek(tz, entry.at)) ?? 0) + 1);
  }
  const inviteDays = [...usage].filter(([, used]) => used.invites > 0).map(([key]) => key).sort();
  /** A day's warm-up allowance under `settings`: earlier days with an invite LinkedIn received. */
  const allowance = (key: string, under: Settings = onDay(key)): number => {
    const cap = under.limits.invitesPerDay;
    if (!under.warmUp.enabled) return cap;
    const earlier = inviteDays.filter((other) => other < key).length;
    return Math.min(cap, under.warmUp.invitesStartPerDay + under.warmUp.invitesIncreasePerDay * earlier);
  };
  const usageOn = (key: string): DayUsage => ({ day: key, ...(usage.get(key) ?? none()), allowance: allowance(key) });

  // ---- every limited action against the limit in force when it happened
  interface Over {
    /** The limit when the count first went over it, and when. */
    readonly limit: number;
    readonly firstOverAt: Date;
  }
  const dayOver = new Map<string, Over>();
  const weekOver = new Map<string, Over>();
  {
    const running = new Map<string, number>();
    const bump = (key: string): number => {
      const count = (running.get(key) ?? 0) + 1;
      running.set(key, count);
      return count;
    };
    const note = (over: Map<string, Over>, key: string, count: number, limit: number, moment: Date): void => {
      if (count > limit && !over.has(key)) over.set(key, { limit, firstOverAt: moment });
    };
    for (const entry of log) {
      const counted = countedAs(entry);
      if (counted === null) continue;
      const key = localDay(tz, entry.at);
      const now = at(entry.at);
      const count = bump(`${key}|${counted}`);
      if (counted === "invites") {
        note(dayOver, `${key}|invites`, count, allowance(key, now), entry.at);
        note(dayOver, `${key}|invites (daily limit)`, count, now.limits.invitesPerDay, entry.at);
        const week = localWeek(tz, entry.at);
        note(weekOver, week, bump(`week ${week}`), now.limits.invitesPerWeek, entry.at);
      } else {
        note(dayOver, `${key}|${COUNTED_WORDS[counted]}`, count, now.limits[DAY_LIMIT[counted]], entry.at);
      }
    }
  }
  /** A day's limits exceeded, each as "<what> <total that day> > <limit when first exceeded>". */
  const overOn = (key: string, label: string, db: Db | null): Violation[] => {
    const used = usageOn(key);
    const totals: Readonly<Record<string, number>> = {
      invites: used.invites,
      "invites (daily limit)": used.invites,
      messages: used.messages,
      "profile views": used.profileViews,
      withdrawals: used.withdrawals,
      "discovery pages": used.discoveryPages,
    };
    const found: Violation[] = [];
    for (const [what, total] of Object.entries(totals)) {
      const over = dayOver.get(`${key}|${what}`);
      if (over === undefined) continue;
      const cross = what === "invites" && db !== null ? { ledgerAllowance: inviteAllowance(db, at(over.firstOverAt), over.firstOverAt) } : {};
      found.push({
        message: `${label}: ${what} ${total} > ${over.limit}`,
        detail: { day: key, firstOverAt: iso(over.firstOverAt), ...(what === "invites" ? { warmUpAllowanceFromWorldLog: over.limit } : {}), ...cross },
      });
    }
    return found;
  };

  const runs = breakRuns(log, settings.breaks.minutesMin * 60_000);
  const longestRun = runs.runs.reduce((most, one) => Math.max(most, one.pieces), 0);

  const opened = openDb(run.dbFile, { durable: false });
  try {
    const db = opened.db;
    const afterDowntime = daysAfterDowntime(db);
    const results: AssertionResult[] = [
      harness(run),
      noStepTwice(),
      noLimitExceeded(db),
      nothingOutsideWorkingHours(),
      nothingAfterReplyOrManual(),
      nobodyInSecondCampaign(),
      noBacklogAfterDowntime(afterDowntime),
    ];
    const ran = itActuallyRan(db, afterDowntime);
    results.push(ran.result, ledgerAgreesWithLinkedIn(db));
    return { seed: run.seed, results, counts: ran.counts, daysAfterDowntime: afterDowntime, wallMs: run.wallMs };
  } finally {
    opened.close();
  }

  // ---------------------------------------------------------------- 0. the harness itself

  function harness(r: SimRun): AssertionResult {
    const violations: Violation[] = r.harnessFailures.map((message) => ({ message }));
    for (const kill of r.kills) {
      if (kill.verified === "swallowed" || kill.verified === "not_revoked" || kill.verified === "pending") {
        violations.push({ message: `kill at ${kill.op ?? "between ticks"}/${kill.phase} did not land (${kill.verified})`, detail: { at: iso(kill.at) } });
      }
    }
    const landed = r.kills.filter((kill) => kill.verified === "rejected" || kill.verified === "revoked").length;
    return {
      id: 0,
      title: "Harness: every kill landed (tick rejected or handle revoked)",
      violations: dedupe(violations),
      notes: [`${landed} of ${r.kills.length} kills seen to land`],
      checked: [{ count: r.kills.length, what: "kills" }],
    };
  }

  // ---------------------------------------------------------------- 1. no step twice

  function noStepTwice(): AssertionResult {
    const violations: Violation[] = [];
    const byMember = new Map<string, LogEntry[]>();
    for (const entry of log) {
      if (entry.kind !== "invite" && entry.kind !== "message") continue;
      const member = memberFor(entry);
      if (member === undefined) {
        violations.push({ message: `the app ${entry.kind === "invite" ? "invited" : "messaged"} a member the scenario never enrolled`, detail: { entry: entryLabel(entry) } });
        continue;
      }
      byMember.set(member.publicId, [...(byMember.get(member.publicId) ?? []), entry]);
    }
    for (const [publicId, entries] of byMember) {
      const member = facts.members.get(publicId);
      if (member === undefined) continue;
      const invites = entries.filter((entry) => entry.kind === "invite");
      const messages = entries.filter((entry) => entry.kind === "message");
      if (invites.length > 1) {
        violations.push({ message: `${publicId}: invited ${invites.length} times by the app`, detail: { at: invites.map((entry) => iso(entry.at)) } });
      }
      // LinkedIn refuses a second invitation to someone pending or connected, so a repeated click
      // shows as a refused attempt (the invite dialog's page load on the profile), not as an invite.
      const firstInvite = invites[0];
      if (firstInvite !== undefined) {
        const retries = log.filter(
          (entry) => entry.kind === "page_load" && entry.page === "profile" && entry.memberId === member.memberId && entry.at > firstInvite.at,
        );
        if (retries.length > 0) {
          violations.push({
            message: `${publicId}: the app tried to invite again after its own invite (LinkedIn refused it)`,
            detail: { invitedAt: iso(firstInvite.at), triedAgainAt: retries.map((entry) => iso(entry.at)) },
          });
        }
      }
      const templates = (pick: (campaign: CampaignFact) => string | null) =>
        member.prospects.map((prospect) => render(pick(campaignOf(prospect)), prospect));
      const expectedNotes = templates((campaign) => campaign.inviteNote);
      for (const invite of invites) {
        const sent = invite.note ?? null;
        const fits = expectedNotes.some((note) => (note.kind === "none" && sent === null) || (note.kind === "text" && note.text === sent));
        if (!fits) {
          violations.push({
            message: `${publicId}: the invite note is not the campaign's note rendered for this person`,
            detail: { at: iso(invite.at), sent, expected: expectedNotes.map(describeRendered) },
          });
        }
      }
      const firsts = templates((campaign) => campaign.firstMessage);
      const follows = templates((campaign) => campaign.followUp);
      messages.forEach((message, index) => {
        const text = message.text ?? "";
        const expected = index === 0 ? firsts : index === 1 ? follows : [];
        if (index > 1) {
          violations.push({ message: `${publicId}: message number ${index + 1} from the app (a sequence has at most two)`, detail: { at: iso(message.at), text } });
          return;
        }
        if (!expected.some((candidate) => candidate.kind === "text" && candidate.text === text)) {
          violations.push({
            message: `${publicId}: the app's ${index === 0 ? "first message" : "follow-up"} is not the template rendered for this person (unresolved name, glued draft or a step sent twice)`,
            detail: { at: iso(message.at), sent: text, expected: expected.map(describeRendered) },
          });
        }
      });
      const texts = messages.map((message) => message.text ?? "");
      texts.forEach((text, index) => {
        if (texts.indexOf(text) !== index) violations.push({ message: `${publicId}: the same text was sent twice by the app`, detail: { text } });
        const glued = texts.find((other) => other !== text && other !== "" && text.includes(other));
        if (glued !== undefined) violations.push({ message: `${publicId}: a message holds another message glued to it (a draft left in the box)`, detail: { text, glued } });
      });
      const threadTexts = world.thread(publicId).filter((message) => message.source === "app").map((message) => message.text);
      threadTexts.forEach((text, index) => {
        if (threadTexts.indexOf(text) !== index) violations.push({ message: `${publicId}: the conversation shows the same app text twice`, detail: { text } });
      });
    }
    const sends = log.filter((entry) => entry.kind === "invite" || entry.kind === "message").length;
    return { id: 1, title: "No step twice", violations: dedupe(violations), notes: [], checked: [{ count: sends, what: "invites and messages" }] };
  }

  // ---------------------------------------------------------------- 2. no limit exceeded

  function noLimitExceeded(db: Db): AssertionResult {
    const violations: Violation[] = [];
    for (const key of [...usage.keys()].sort()) violations.push(...overOn(key, key, db));
    for (const [week, count] of [...weekInvites].sort()) {
      const over = weekOver.get(week);
      if (over !== undefined) violations.push({ message: `week of ${week}: invites ${count} > ${over.limit}`, detail: { firstOverAt: iso(over.firstOverAt) } });
    }
    const busiest = [...usage.keys()].sort().map((key) => usageOn(key)).filter((used) => used.invites + used.messages > 0);
    const notes = busiest.map((used) => {
      const { limits } = onDay(used.day);
      return `${used.day}: invites ${used.invites}/${used.allowance}, messages ${used.messages}/${limits.messagesPerDay}, views ${used.profileViews}/${limits.profileViewsPerDay}, withdrawals ${used.withdrawals}/${limits.withdrawalsPerDay}`;
    });
    notes.push(...[...weekInvites].sort().map(([week, count]) => `week of ${week}: invites ${count}/${onDay(addDays(week, 6)).limits.invitesPerWeek}`));
    const changes = facts.settingsHistory.filter((change) => change.at > scenario.start);
    if (changes.length > 0) notes.push(`${changes.length} settings change(s) during the run, each action judged by the settings then: ${changes.map((change) => iso(change.at)).join(", ")}`);
    const counted = [...usage.values()].reduce((sum, used) => sum + used.invites + used.messages + used.profileViews + used.withdrawals + used.discoveryPages, 0);
    return {
      id: 2,
      title: "No limit exceeded (per local day and week, warm-up from the world's log, each action under the settings in force then)",
      violations,
      notes,
      checked: [
        { count: counted, what: "actions counted against the limits" },
        { count: usage.size + weekInvites.size, what: "day and week totals" },
      ],
    };
  }

  // ---------------------------------------------------------------- 3. nothing outside working hours

  /**
   * A read the laptop slept through started inside the window, at its `before` kill point, and the
   * world stamps its page load when it finally loaded, possibly after the window closed. That one
   * entry is not counted: the app started it in time. Anything the app started after it (a send, a
   * claim's page load, the next read) is. Writes get no such excuse: whatever a send, an invite or
   * a withdrawal the laptop slept through left outside the window is counted.
   */
  function sleptThrough(read: Suspension, entry: LogEntry): boolean {
    if (isWriteOp(read.op) || !READ_KINDS.has(entry.kind) || entry.at.getTime() !== read.landsAt.getTime()) return false;
    const anonymous = entry.publicId === undefined && entry.memberId === undefined;
    return anonymous || entry.publicId === read.target || memberFor(entry)?.publicId === read.target;
  }

  function nothingOutsideWorkingHours(): AssertionResult {
    const reads = run.suspensions.filter((one) => !isWriteOp(one.op));
    const writes = run.suspensions.filter((one) => isWriteOp(one.op));
    const slept = reads.filter((read) => inWorkingWindow(settings, read.startedAt));
    const violations: Violation[] = [];
    let excused = 0;
    for (const entry of log) {
      if (inWorkingWindow(settings, entry.at)) continue;
      if (slept.some((read) => sleptThrough(read, entry))) {
        excused += 1;
        continue;
      }
      violations.push({ message: `outside the working window: ${entryLabel(entry)}` });
    }
    const by = (list: readonly Suspension[], cause: Suspension["cause"]): number => list.filter((one) => one.cause === cause).length;
    const lateWrites = writes.filter((write) => !inWorkingWindow(settings, write.landsAt)).length;
    return {
      id: 3,
      title: "Nothing outside working hours (every page load and send the app started; no excuse for a send)",
      violations,
      notes: [
        `${log.length} log entries checked`,
        `${reads.length} reads the laptop slept through (${by(reads, "slot")} planned, ${by(reads, "lead_in")} stretched to just before a planned send, ${by(reads, "random")} random);` +
          ` ${excused} of their own page loads landed after the window closed and are not counted, because the app started them inside it`,
        `${writes.length} sends the laptop slept through (${by(writes, "send_sleep")} planned, ${by(writes, "random")} random), ${lateWrites} of them waking after the window closed; nothing they did is excused`,
      ],
      checked: [
        { count: log.length, what: "page loads and sends" },
        { count: reads.length, what: "reads the laptop slept through" },
        { count: writes.length, what: "sends the laptop slept through" },
      ],
    };
  }

  // ---------------------------------------------------------------- 4. nothing after a reply or a manual message

  /**
   * Whatever the timing: an app message that follows a member's message or a manual message in the
   * conversation is a violation, even when the other message landed between the app's thread read
   * and its send (the driver compares the conversation right before sending for exactly that).
   */
  function nothingAfterReplyOrManual(): AssertionResult {
    const violations: Violation[] = [];
    let checkedMessages = 0;
    for (const member of facts.members.values()) {
      const thread = world.thread(member.publicId);
      checkedMessages += thread.filter((message) => message.source === "app").length;
      const reads = log.filter((entry) => entry.kind === "thread_read" && (entry.publicId === member.publicId || entry.memberId === member.memberId));
      thread.forEach((sent, index) => {
        if (sent.source !== "app") return;
        const blockers = thread.slice(0, index).filter((message: WorldMessage) => message.source === "member" || message.source === "manual");
        if (blockers.length === 0) return;
        const lastRead = reads.filter((read) => read.at <= sent.at).at(-1);
        violations.push({
          message: `${member.publicId}: the app sent a message after ${blockers.map((blocker) => (blocker.source === "member" ? "a reply" : "a manual message")).join(" and ")}`,
          detail: {
            sent: { at: iso(sent.at), text: sent.text },
            earlier: blockers.map((blocker) => ({ at: iso(blocker.at), source: blocker.source, text: blocker.text })),
            lastThreadRead: lastRead === undefined ? null : iso(lastRead.at),
          },
        });
      });
    }
    const midSend = run.interventions.filter((record) => record.phase === "fired" && facts.members.get(record.target)?.expect?.kind === "replies_mid_send").length;
    return {
      id: 4,
      title: "Nothing after a reply or a manual message (whatever the timing)",
      violations,
      notes: [`${midSend} replies landed between the app's thread read and its send`],
      checked: [{ count: checkedMessages, what: "messages checked against the conversation" }],
    };
  }

  // ---------------------------------------------------------------- 5. nobody contacted in a second campaign

  function nobodyInSecondCampaign(): AssertionResult {
    const violations: Violation[] = [];
    const invitesByMember = new Map<string, LogEntry[]>();
    for (const entry of log) {
      if (entry.kind !== "invite") continue;
      const member = memberFor(entry);
      const key = member?.memberId ?? entry.memberId ?? entry.publicId ?? "?";
      invitesByMember.set(key, [...(invitesByMember.get(key) ?? []), entry]);
    }
    const traps = [...facts.members.values()].filter((member) => member.trapSince !== null);
    const notContact = [...facts.members.values()].filter((member) => member.doNotContact);
    const pairs = [...facts.members.values()].filter((member) => new Set(member.prospects.map((prospect) => prospect.personPublicId)).size > 1 || member.role.startsWith("shared_member_id"));
    for (const member of facts.members.values()) {
      const invites = invitesByMember.get(member.memberId) ?? [];
      const total = invites.length + member.preRunInvites;
      if (total > 1) {
        violations.push({
          message: `${member.publicId} (${member.role}): invited ${total} times over the install's life (${member.preRunInvites} before the run, ${invites.length} by the app)`,
          detail: { at: invites.map((entry) => iso(entry.at)), rowsInvited: [...new Set(invites.map((entry) => entry.publicId))] },
        });
      }
      if (member.doNotContact && invites.length > 0) violations.push({ message: `${member.publicId}: do-not-contact person was invited`, detail: { at: invites.map((entry) => iso(entry.at)) } });
      if (member.trapSince !== null) {
        const since = member.trapSince;
        const contacts = log.filter((entry) => SEND_KINDS.has(entry.kind) && entry.kind !== "withdraw" && memberFor(entry) === member && entry.at >= since);
        for (const contact of contacts) {
          violations.push({ message: `${member.publicId} (${member.role}): contacted again after their first campaign closed`, detail: { entry: entryLabel(contact), text: contact.text ?? contact.note ?? null } });
        }
      }
    }
    return {
      id: 5,
      title: "Nobody contacted in a second campaign",
      violations: dedupe(violations),
      notes: [`${traps.length} suppression traps, ${notContact.length} do-not-contact, ${pairs.length} shared-member-id cases`],
      checked: [
        { count: log.filter((entry) => entry.kind === "invite" || entry.kind === "message").length, what: "invites and messages" },
        { count: traps.length + notContact.length + pairs.length, what: "people who must not be contacted again" },
      ],
    };
  }

  // ---------------------------------------------------------------- 6. no backlog after downtime

  /**
   * The first working day after each downtime, with what it used. `full` when the laptop was on
   * before the window opened; `atLimit` when the app's claims that day (what its budgets count,
   * decision 35) reached the day's invite allowance or message limit.
   */
  function daysAfterDowntime(db: Db): DayAfterDowntime[] {
    return scenario.downtimes.map((downtime) => {
      const key = firstWorkingDayFrom(settings, downtime.to);
      const window = windowOn(settings, key);
      const then = onDay(key);
      const claims = (types: ("invite" | "message")[]): number =>
        db
          .select({ id: actions.id })
          .from(actions)
          .where(and(inArray(actions.type, types), gte(actions.startedAt, localDayStart(key)), lt(actions.startedAt, localDayStart(addDays(key, 1)))))
          .all().length;
      const atLimit = claims(["invite"]) >= inviteAllowance(db, then, window.start) || claims(["message"]) >= then.limits.messagesPerDay;
      return {
        ...usageOn(key),
        downtime: `${iso(downtime.from)} → ${iso(downtime.to)}`,
        messageLimit: then.limits.messagesPerDay,
        full: downtime.to.getTime() <= window.start.getTime(),
        atLimit,
      };
    });
  }

  /** Midnight starting a local day (it exists in every zone the scenarios use). */
  function localDayStart(key: string): Date {
    return localInstant(tz, key, 0);
  }

  function noBacklogAfterDowntime(days: readonly DayAfterDowntime[]): AssertionResult {
    const violations: Violation[] = [];
    const notes: string[] = [];
    for (const used of days) {
      violations.push(...overOn(used.day, `day after downtime ${used.day}`, null));
      const { limits } = onDay(used.day);
      notes.push(
        `day after downtime (${used.downtime}): ${used.day}${used.full ? " (a full working day)" : ""} invites ${used.invites}/${used.allowance}, messages ${used.messages}/${limits.messagesPerDay}, profile views ${used.profileViews}/${limits.profileViewsPerDay}, withdrawals ${used.withdrawals}/${limits.withdrawalsPerDay}`,
      );
    }
    const minGapMs = settings.actionGapSeconds.min * 1000;
    let closest = Number.POSITIVE_INFINITY;
    let gaps = 0;
    for (let index = 1; index < log.length; index++) {
      const previous = log[index - 1];
      const current = log[index];
      if (previous === undefined || current === undefined) continue;
      const gap = current.at.getTime() - previous.at.getTime();
      if (samePiece(previous, current)) continue;
      gaps += 1;
      closest = Math.min(closest, gap);
      if (gap < minGapMs) {
        violations.push({ message: `two actions ${(gap / 1000).toFixed(1)} s apart (minimum ${settings.actionGapSeconds.min} s)`, detail: { first: entryLabel(previous), second: entryLabel(current) } });
      }
    }
    notes.push(`closest two separate pieces of work: ${Number.isFinite(closest) ? `${(closest / 1000).toFixed(1)} s` : "n/a"}`);
    const { breaks } = settings;
    for (const one of runs.runs) {
      if (one.pieces <= breaks.everyActionsMax) continue;
      violations.push({
        message: `${one.pieces} pieces of work in a row without a break of ${breaks.minutesMin} min or more (at most ${breaks.everyActionsMax}), counted across kills and restarts`,
        detail: { from: entryLabel(one.from), to: entryLabel(one.to), processStarts: run.processStarts.filter((start) => start >= one.from.at && start <= one.to.at).length },
      });
    }
    notes.push(`longest run of pieces of work without a break of ${breaks.minutesMin} min or more: ${longestRun} (at most ${breaks.everyActionsMax}), across kills and restarts`);
    notes.push(`${NORMAL_DAY_NOTE}${normalDay()}`);
    return {
      id: 6,
      title: `No backlog after downtime, and a normal day: ${normalDay()}`,
      violations,
      notes,
      checked: [
        { count: scenario.downtimes.length, what: "days after downtime" },
        { count: gaps, what: "gaps between actions" },
        { count: runs.pieces, what: "pieces of work checked for breaks" },
      ],
    };
  }

  function normalDay(): string {
    const { breaks, actionGapSeconds } = settings;
    return (
      `within every daily limit, at least ${actionGapSeconds.min} s between pieces of work, and a break of at least ${breaks.minutesMin} min` +
      ` within every ${breaks.everyActionsMax} pieces of work over the whole run, kills and restarts included (downtime and nights are breaks)`
    );
  }

  // ---------------------------------------------------------------- 7. it actually ran, and nothing is stuck

  function itActuallyRan(db: Db, afterDowntime: readonly DayAfterDowntime[]): { result: AssertionResult; counts: Verdict["counts"] } {
    const violations: Violation[] = [];
    const start = scenario.start;
    const appMessages = new Map<string, number>();
    for (const entry of log) {
      if (entry.kind !== "message") continue;
      const member = memberFor(entry);
      if (member !== undefined) appMessages.set(member.publicId, (appMessages.get(member.publicId) ?? 0) + 1);
    }
    const prospectRows = db.select().from(prospects).all();
    const personRows = db.select().from(people).all();
    const personById = new Map(personRows.map((person) => [person.id, person]));
    const heldPublicIds = new Set(
      prospectRows.filter((row) => row.stage === "needs_review").map((row) => personById.get(row.personId)?.publicId ?? ""),
    );
    const stops = db.select().from(safetyStops).all();

    const reconcile = { confirmed: 0, retried: 0, held: 0, notRetried: 0 };
    for (const uncertain of run.uncertainSends) {
      const member = facts.members.get(uncertain.publicId);
      const held = member?.prospects.some((prospect) => heldPublicIds.has(prospect.personPublicId)) ?? false;
      if (uncertain.effect) {
        if (held) reconcile.held += 1;
        else reconcile.confirmed += 1;
        continue;
      }
      const later = log.some((entry) => entry.kind === uncertain.kind && entry.at > uncertain.at && memberFor(entry)?.publicId === uncertain.publicId);
      if (later) reconcile.retried += 1;
      else if (held) reconcile.held += 1;
      else reconcile.notRetried += 1;
    }

    const kills = run.kills.filter((kill) => kill.cause !== "downtime");
    const expecting = (publicId: string | null, ...kinds: Expectation["kind"][]): boolean => {
      const kind = publicId === null ? undefined : facts.members.get(publicId)?.expect?.kind;
      return kind !== undefined && kinds.includes(kind);
    };
    const fired = run.interventions.filter((record) => record.phase === "fired");
    const weekly = weeksStoppedByWeeklyLimit(db);
    const counts: Verdict["counts"] = {
      invites: log.filter((entry) => entry.kind === "invite").length,
      acceptancesObserved: prospectRows.filter((row) => row.acceptanceObservedAt !== null && row.acceptanceObservedAt >= start).length,
      firstMessages: [...appMessages.values()].filter((count) => count >= 1).length,
      followUps: [...appMessages.values()].filter((count) => count >= 2).length,
      withdrawals: log.filter((entry) => entry.kind === "withdraw").length,
      stoppedReplied: prospectRows.filter((row) => row.stage === "stopped" && row.stopReason === "replied" && (row.closedAt ?? start) >= start).length,
      stoppedManual: prospectRows.filter((row) => row.stage === "stopped" && row.stopReason === "manual_takeover" && (row.closedAt ?? start) >= start).length,
      needsReview: prospectRows.filter((row) => row.stage === "needs_review").length,
      killsBefore: kills.filter((kill) => kill.phase === "before").length,
      killsTyped: kills.filter((kill) => kill.phase === "typed").length,
      killsAfter: kills.filter((kill) => kill.phase === "after").length,
      killsBetween: kills.filter((kill) => kill.phase === "between").length,
      killsDuringReconcileRead: kills.filter((kill) => kill.duringReconcileRead).length,
      killsBeforeTickCompleted: kills.filter((kill) => kill.beforeTickCompleted).length,
      reconcileConfirmedSent: reconcile.confirmed,
      reconcileRetried: reconcile.retried,
      safetyStopCheckpoint: stops.filter((stop) => stop.reason === "checkpoint").length,
      safetyStopLimit: stops.filter((stop) => stop.reason === "limit_hit").length,
      repliesMidSend: fired.filter((record) => expecting(record.target, "replies_mid_send")).length,
      suspendedReadsPlanned: run.suspensions.filter((one) => one.cause === "slot").length,
      suspendedSendsPlanned: run.suspensions.filter((one) => one.cause === "send_sleep").length,
      changesMidTick: fired.filter((record) => expecting(record.target, "paused_mid_read", "changed_mid_tick")).length,
      settingsChangedMidRead: fired.filter((record) => record.tag === "settings_mid_read").length,
      killsOnReplyAndTakeover: kills.filter((kill) => kill.cause === "forced" && expecting(kill.target, "stops_after_kill")).length,
      killsInBurst: kills.filter((kill) => kill.cause === "burst").length,
      weeksStoppedByWeeklyLimit: weekly.length,
      fullDaysAfterDowntimeAtLimit: afterDowntime.filter((day) => day.full && day.atLimit).length,
      engineErrors: run.engineErrors.length,
      downtimeRestarts: run.kills.filter((kill) => kill.cause === "downtime").length,
      reconcileHeld: reconcile.held,
      reconcileNotRetried: reconcile.notRetried,
      safetyStopOther: stops.filter((stop) => stop.reason !== "checkpoint" && stop.reason !== "limit_hit").length,
      ticks: run.ticks,
      ticksWithWork: run.ticksWithWork,
      kills: kills.length,
      suspendedReadsRandom: run.suspensions.filter((one) => one.cause === "random" && !isWriteOp(one.op)).length,
      suspendedSendsRandom: run.suspensions.filter((one) => one.cause === "random" && isWriteOp(one.op)).length,
      longestRunWithoutBreak: longestRun,
    };
    for (const key of MINIMUM_KEYS) {
      const need = scenario.minimums[key];
      if (counts[key] < need) violations.push({ message: `too few ${key}: ${counts[key]}, need at least ${need}` });
    }
    if (run.engineErrors.length > 0) {
      violations.push({
        message: `the engine's tick rejected ${run.engineErrors.length} times without a kill (a crash in production)`,
        detail: { first: run.engineErrors.slice(0, 5).map((error) => `${iso(error.at)} ${error.message}`) },
      });
    }
    for (const day of afterDowntime) {
      if (!day.full || day.atLimit) continue;
      violations.push({
        message: `day after downtime ${day.day} was a full working day but reached neither its invite allowance nor its message limit, so the backlog check on it proves nothing`,
        detail: { downtime: day.downtime, invites: day.invites, allowance: day.allowance, messages: day.messages, messageLimit: day.messageLimit },
      });
    }
    violations.push(...scriptedPaths(prospectRows));
    const ledgerRows = db.select().from(actions).all();
    violations.push(...stuck(db, ledgerRows, prospectRows, stops));
    const scripted = [...facts.members.values()].filter((member) => member.scripted).length;
    return {
      result: {
        id: 7,
        title: "It actually ran, scripted paths held, and nothing is silently stuck (a step may stay unknown only while its prospect is in needs review)",
        violations,
        notes: [
          `weeks the weekly invite limit, not the daily one, ended invites: ${weekly.length === 0 ? "none" : weekly.join("; ")}`,
          `full working days after a downtime at their invite or message limit: ${afterDowntime.filter((day) => day.full && day.atLimit).map((day) => day.day).join(", ") || "none"}`,
        ],
        checked: [
          { count: MINIMUM_KEYS.length, what: "minimum counts" },
          { count: scripted, what: "scripted members" },
          { count: ledgerRows.length, what: "ledger rows" },
        ],
      },
      counts,
    };
  }

  /**
   * Weeks in which the weekly invite limit, not the daily one, ended invites, from the app's claims
   * (what its budgets count, decision 35): the claim that brought the week to the weekly limit in
   * force then came on a day whose claims stayed below that day's allowance. One line per week.
   */
  function weeksStoppedByWeeklyLimit(db: Db): string[] {
    const claims = db
      .select({ startedAt: actions.startedAt })
      .from(actions)
      .where(eq(actions.type, "invite"))
      .all()
      .flatMap((row) => (row.startedAt === null ? [] : [row.startedAt]))
      .sort((a, b) => a.getTime() - b.getTime());
    const byWeek = new Map<string, Date[]>();
    for (const claim of claims) byWeek.set(localWeek(tz, claim), [...(byWeek.get(localWeek(tz, claim)) ?? []), claim]);
    const found: string[] = [];
    for (const [week, list] of [...byWeek].sort()) {
      const reaching = list.find((claim, index) => index + 1 >= at(claim).limits.invitesPerWeek);
      if (reaching === undefined) continue;
      const day = localDay(tz, reaching);
      const onThatDay = list.filter((claim) => localDay(tz, claim) === day).length;
      const allowed = inviteAllowance(db, at(reaching), reaching);
      if (onThatDay < allowed) found.push(`week of ${week}: ${at(reaching).limits.invitesPerWeek} reached on ${day} with ${onThatDay} of ${allowed} that day`);
    }
    return found;
  }

  /**
   * The scripted members' paths, from the world's log (what LinkedIn received), the harness's
   * records (kills, interventions, send calls) and, for where each ended, the app's database:
   * - no text anyone received may use a title as a first name or greet nobody ("Hi ,");
   * - a campaign with no follow-up sends one message at most;
   * - each member with an `Expectation` ends on its path (see `Expectation` in harness.ts).
   */
  function scriptedPaths(prospectRows: (typeof prospects.$inferSelect)[]): Violation[] {
    const found: Violation[] = [];
    const firedOn = (publicId: string) => run.interventions.find((record) => record.target === publicId && record.phase === "fired");
    const rowById = new Map(prospectRows.map((row) => [row.id, row]));
    for (const entry of log) {
      const text = entry.kind === "message" ? entry.text : entry.kind === "invite" ? entry.note : undefined;
      if (text === undefined || !UNNAMED_TEXT.test(text)) continue;
      found.push({
        message: `${entry.publicId ?? entry.memberId ?? "?"}: the app sent a${entry.kind === "invite" ? "n invite note" : " message"} with a title for a name, an empty greeting or a placeholder`,
        detail: { at: iso(entry.at), text },
      });
    }
    const blank = new Set([...facts.campaigns.values()].filter((campaign) => campaign.followUp.trim() === "").map((campaign) => campaign.key));
    for (const member of facts.members.values()) {
      if (member.prospects.length === 0 || !member.prospects.every((prospect) => blank.has(prospect.campaign))) continue;
      const sent = world.messagesSentTo(member.publicId);
      if (sent.length > 1) {
        found.push({
          message: `${member.publicId} (${member.role}): ${sent.length} messages in a campaign with no follow-up (one at most)`,
          detail: { at: sent.map((entry) => iso(entry.at)) },
        });
      }
    }
    for (const member of facts.members.values()) {
      const expect = member.expect;
      const prospect = member.prospects[0];
      if (expect === null || prospect === undefined) continue;
      const row = rowById.get(prospect.prospectId);
      const ended = row === undefined ? "missing" : `${row.stage}${row.stopReason === null ? "" : ` (${row.stopReason})`}`;
      const who = `${member.publicId} (${member.role})`;
      const messagesTo = world.messagesSentTo(member.publicId);
      switch (expect.kind) {
        case "never_greeted": {
          const notes = world.invitesTo(member.publicId).filter((entry) => entry.note !== undefined);
          if (notes.length > 0) found.push({ message: `${who}: has no first name, yet an invite note reached them`, detail: { notes: notes.map((entry) => entry.note ?? "") } });
          if (messagesTo.length > 0) found.push({ message: `${who}: has no first name, yet a message reached them`, detail: { texts: messagesTo.map((entry) => entry.text ?? "") } });
          if (row?.stage !== "needs_review") found.push({ message: `${who}: has no first name and ends ${ended}, not in needs review` });
          break;
        }
        case "stops_on_reply": {
          if (messagesTo.length === 0) {
            found.push({ message: `${who}: never got the first message, so the reply after it was never tested (ends ${ended})` });
            break;
          }
          const replied = world.thread(member.publicId).some((message) => message.source === "member");
          if (!replied) found.push({ message: `${who}: got the first message but never replied by the end of the run (ends ${ended})` });
          else if (row?.stage !== "stopped" || row.stopReason !== "replied") found.push({ message: `${who}: replied after the first message and ends ${ended}, not stopped (replied)` });
          break;
        }
        case "replies_mid_send": {
          const fired = firedOn(member.publicId);
          if (fired === undefined) {
            found.push({ message: `${who}: the app never reached the send, so a reply between its thread read and its send was never tested (ends ${ended})` });
            break;
          }
          const after = messagesTo.filter((entry) => entry.at >= fired.at);
          if (after.length > 0) found.push({ message: `${who}: ${after.length} message(s) from the app after their reply landed mid-send`, detail: { replyAt: iso(fired.at), sent: after.map((entry) => iso(entry.at)) } });
          if (row?.stage !== "stopped" || row.stopReason !== "replied") found.push({ message: `${who}: replied between the thread read and the send and ends ${ended}, not stopped (replied)` });
          break;
        }
        case "stops_after_kill": {
          const kill = run.kills.find((record) => record.target === member.publicId && record.cause === "forced" && record.op === "sendMessage" && record.phase === expect.phase);
          if (kill === undefined) {
            found.push({ message: `${who}: the forced kill at sendMessage/${expect.phase} never landed (ends ${ended})` });
            break;
          }
          if (messagesTo.length > 1) found.push({ message: `${who}: ${messagesTo.length} messages from the app after a kill at sendMessage/${expect.phase} (at most one first message)`, detail: { at: messagesTo.map((entry) => iso(entry.at)) } });
          if (row?.stage !== "stopped" || row.stopReason !== expect.reason) found.push({ message: `${who}: killed at sendMessage/${expect.phase}, then ${expect.reason === "replied" ? "replied" : "written to by hand"}; ends ${ended}, not stopped (${expect.reason})` });
          break;
        }
        case "send_never_succeeds": {
          const calls = run.sendCalls.filter((call) => call.op === "sendMessage" && call.target === member.publicId).length;
          const boxLoads = log.filter((entry) => entry.kind === "page_load" && entry.page === "messaging" && memberFor(entry) === member).length;
          const attempts = Math.max(calls, boxLoads);
          if (attempts === 0) found.push({ message: `${who}: the app never tried to send, so a send that never succeeds was never tested (ends ${ended})` });
          if (attempts > MAX_SEND_ATTEMPTS) found.push({ message: `${who}: every send fails before its effect, and the app tried ${attempts} times (at most ${MAX_SEND_ATTEMPTS})`, detail: { sendCalls: calls, messageBoxLoads: boxLoads } });
          if (messagesTo.length > 0) found.push({ message: `${who}: every send fails before its effect, yet a message reached them` });
          if (row?.stage !== "needs_review") found.push({ message: `${who}: every send fails before its effect and ends ${ended}, not in needs review` });
          break;
        }
        case "paused_mid_read": {
          const fired = firedOn(member.publicId);
          const resumed = run.interventions.find((record) => record.target === member.publicId && record.phase === "later");
          if (fired === undefined) {
            found.push({ message: `${who}: their thread was never read, so a campaign paused mid-read was never tested (ends ${ended})` });
            break;
          }
          if (row?.stage === "needs_review") found.push({ message: `${who}: their campaign was paused while their thread loaded, and they are held for review`, detail: { reason: row.reviewReason } });
          if (resumed === undefined) {
            found.push({ message: `${who}: their campaign was paused mid-read and never resumed before the end` });
            break;
          }
          const whilePaused = log.filter((entry) => SEND_KINDS.has(entry.kind) && memberFor(entry) === member && entry.at >= fired.at && entry.at < resumed.at);
          if (whilePaused.length > 0) found.push({ message: `${who}: reached by the app while their campaign was paused`, detail: { sends: whilePaused.map(entryLabel) } });
          const workedAgain = log.some((entry) => memberFor(entry) === member && entry.at > resumed.at);
          if (!workedAgain) found.push({ message: `${who}: not worked again after their campaign resumed (ends ${ended})`, detail: { pausedAt: iso(fired.at), resumedAt: iso(resumed.at) } });
          break;
        }
        case "changed_mid_tick": {
          const fired = firedOn(member.publicId);
          if (fired === undefined) {
            found.push({ message: `${who}: never read, so a prospect ${expect.to} mid-tick was never tested (ends ${ended})` });
            break;
          }
          const after = log.filter((entry) => SEND_KINDS.has(entry.kind) && memberFor(entry) === member && entry.at >= fired.at);
          if (after.length > 0) found.push({ message: `${who}: ${after.length} send(s) reached them after the user ${expect.to === "rejected" ? "rejected" : "stopped"} the prospect mid-tick`, detail: { changedAt: iso(fired.at), sends: after.map(entryLabel) } });
          if (row?.stage !== expect.to) found.push({ message: `${who}: the user ${expect.to === "rejected" ? "rejected" : "stopped"} the prospect mid-tick and it ends ${ended}`, detail: { reason: row?.reviewReason ?? null } });
          break;
        }
        case "send_slept_through": {
          const what = WRITE_WORDS[expect.op];
          const slept = run.suspensions.find((one) => one.cause === "send_sleep" && one.op === expect.op && one.target === member.publicId);
          if (slept === undefined) {
            found.push({ message: `${who}: the laptop never slept through their ${what}, so a ${what} started just before the window closed was never tested (ends ${ended})` });
            break;
          }
          const startedDay = localDay(tz, slept.startedAt);
          const closes = windowOn(settings, startedDay).end;
          if (!inWorkingWindow(settings, slept.startedAt) || closes.getTime() - slept.startedAt.getTime() > SLEEP_STARTS_WITHIN_MS || slept.landsAt <= closes) {
            found.push({ message: `${who}: their ${what} did not start in the window's last minutes and wake after it closed`, detail: { startedAt: iso(slept.startedAt), landsAt: iso(slept.landsAt), windowEnd: iso(closes) } });
          }
          const effects = log.filter((entry) => entry.kind === WRITE_KIND[expect.op] && memberFor(entry) === member);
          const outside = effects.filter((entry) => !inWorkingWindow(settings, entry.at));
          if (outside.length > 0) found.push({ message: `${who}: their ${what} went out outside the working window after the laptop slept through it`, detail: { at: outside.map((entry) => iso(entry.at)) } });
          const later = effects.find((entry) => entry.at > slept.landsAt && inWorkingWindow(settings, entry.at) && localDay(tz, entry.at) > startedDay);
          if (later === undefined) found.push({ message: `${who}: their ${what} never went out in a later window after the laptop slept through it (ends ${ended})`, detail: { sleptFrom: iso(slept.startedAt) } });
          if (row?.stage === "needs_review") found.push({ message: `${who}: held for review after the laptop slept through their ${what}`, detail: { reason: row.reviewReason } });
          break;
        }
        case "follow_up_cleared_mid_read": {
          const fired = firedOn(member.publicId);
          const restored = run.interventions.find((record) => record.target === member.publicId && record.phase === "later");
          if (fired === undefined) {
            found.push({ message: `${who}: their follow-up thread was never read, so a follow-up cleared mid-read was never tested (ends ${ended})` });
            break;
          }
          const reads = log.filter((entry) => entry.kind === "thread_read" && memberFor(entry) === member);
          // A message after the cleared read must come from a later read, one that started after the text was back.
          const fromThatRead = messagesTo.filter(
            (entry) => entry.at >= fired.at && !reads.some((read) => restored !== undefined && read.at > restored.at && read.at <= entry.at),
          );
          if (fromThatRead.length > 0) found.push({ message: `${who}: a follow-up came from the read during which the user cleared it`, detail: { clearedAt: iso(fired.at), restoredAt: restored === undefined ? null : iso(restored.at), sent: fromThatRead.map((entry) => iso(entry.at)) } });
          if (row?.stage === "needs_review") found.push({ message: `${who}: held for review after the user cleared the follow-up mid-read`, detail: { reason: row.reviewReason } });
          break;
        }
        default: {
          const _exhaustive: never = expect;
          throw new Error(`unknown expectation ${String(_exhaustive)}`);
        }
      }
    }
    return found;
  }

  /**
   * Nothing silently stuck. No ledger row is in progress at the end; a read row is never unknown
   * (it ends done or failed); a step row (`invite:`, `message1:`, `followup:`, `withdraw:`) may stay
   * unknown only while its prospect is in needs review, where the user decides. And no prospect
   * sits due while its campaign ran and the budgets had room.
   */
  function stuck(
    db: Db,
    ledgerRows: (typeof actions.$inferSelect)[],
    prospectRows: (typeof prospects.$inferSelect)[],
    stops: (typeof safetyStops.$inferSelect)[],
  ): Violation[] {
    const found: Violation[] = [];
    const stageOf = new Map(prospectRows.map((row) => [row.id, row.stage]));
    for (const row of ledgerRows) {
      if (row.status !== "in_progress" && row.status !== "unknown") continue;
      const detail = { startedAt: row.startedAt === null ? null : iso(row.startedAt) };
      if (!STEP_KEY.test(row.idempotencyKey)) {
        found.push({ message: `read row ${row.idempotencyKey} is still ${row.status} at the end (a read ends done or failed, never ${row.status})`, detail });
        continue;
      }
      const stage = row.prospectId === null ? undefined : stageOf.get(row.prospectId);
      if (row.status === "unknown" && stage === "needs_review") continue;
      found.push({
        message: `step row ${row.idempotencyKey} is still ${row.status} at the end and its prospect is ${stage ?? "missing"} (a step may stay unknown only while its prospect is in needs review)`,
        detail,
      });
    }
    const lastDays = lastWorkingDaysBefore(settings, run.finishedAt, 2);
    const oldest = lastDays.at(-1);
    if (oldest === undefined || lastDays.length < 2) return found;
    const cutoff = windowOn(settings, oldest).start;
    const campaignRows = new Map(db.select().from(campaigns).all().map((campaign) => [campaign.id, campaign]));
    const publicIds = new Map(db.select({ id: people.id, publicId: people.publicId }).from(people).all().map((person) => [person.id, person.publicId]));
    const halted = (key: string): boolean => {
      const { start, end } = windowOn(settings, key);
      return stops.some((stop) => stop.raisedAt < end && (stop.resumedAt === null || stop.resumedAt > start));
    };
    const invitesBlocked = (key: string): boolean => {
      const { start } = windowOn(settings, key);
      return stops.some((stop) => stop.invitesBlockedUntil !== null && stop.invitesBlockedUntil > start);
    };
    /** The app's claims of `type` started in [from, to): what its budgets count (decision 35), sent or not. */
    const claimed = (type: "invite" | "message" | "profile_view", from: string, days: number): number =>
      db
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.type, type), gte(actions.startedAt, localDayStart(from)), lt(actions.startedAt, localDayStart(addDays(from, days)))))
        .all().length;
    // Budgets had room only if neither what LinkedIn received nor what the app claimed reached the limit.
    const room = (stage: string, followUpBlank: boolean, key: string): string | null => {
      if (halted(key)) return null;
      const used = usageOn(key);
      const { limits } = onDay(key);
      if (stage === "approved") {
        const monday = localWeek(tz, windowOn(settings, key).start);
        const invites = Math.max(used.invites, claimed("invite", key, 1));
        const week = Math.max(weekInvites.get(monday) ?? 0, claimed("invite", monday, 7));
        const views = Math.max(used.profileViews, claimed("profile_view", key, 1));
        const open = !invitesBlocked(key) && invites < Math.min(used.allowance, limits.invitesPerDay) && week < limits.invitesPerWeek && views < limits.profileViewsPerDay;
        return open ? `${key}: invites ${invites}/${used.allowance}, week ${week}/${limits.invitesPerWeek}, views ${views}/${limits.profileViewsPerDay}` : null;
      }
      if (stage === "message_sent" && followUpBlank) return `${key}: no follow-up to send, nothing needs budget`;
      const messages = Math.max(used.messages, claimed("message", key, 1));
      return messages < limits.messagesPerDay ? `${key}: messages ${messages}/${limits.messagesPerDay}` : null;
    };
    for (const row of prospectRows) {
      if (row.stage !== "approved" && row.stage !== "accepted" && row.stage !== "message_sent") continue;
      const campaign = campaignRows.get(row.campaignId);
      if (campaign === undefined || campaign.status !== "running") continue;
      const due = row.nextActionAt ?? (row.stage === "approved" ? row.approvedAt : row.stage === "accepted" ? row.acceptanceObservedAt : row.firstMessageSentAt) ?? row.foundAt;
      if (due >= cutoff) continue;
      const roomOn = lastDays.map((key) => room(row.stage, campaign.followUp.trim() === "", key)).filter((reason): reason is string => reason !== null);
      if (roomOn.length === 0) continue;
      found.push({
        message: `prospect ${row.id} (${publicIds.get(row.personId) ?? `person ${row.personId}`}) sits in ${row.stage}, due ${iso(due)}, while its campaign ran and budgets had room`,
        detail: { room: roomOn },
      });
    }
    return found;
  }

  // ---------------------------------------------------------------- 8. the ledger agrees with LinkedIn

  function ledgerAgreesWithLinkedIn(db: Db): AssertionResult {
    const violations: Violation[] = [];
    const personRows = db.select().from(people).all();
    const prospectRows = db.select().from(prospects).all();
    const rows = db.select().from(actions).all();
    const personOfProspect = new Map(prospectRows.map((row) => [row.id, personRows.find((person) => person.id === row.personId)]));
    const step = (row: (typeof rows)[number]): "invite" | "message1" | "followup" | "withdraw" | null => {
      if (row.type === "invite" || row.type === "withdraw") return row.type;
      if (row.type !== "message") return null;
      if (row.idempotencyKey.startsWith("message1:")) return "message1";
      if (row.idempotencyKey.startsWith("followup:")) return "followup";
      return null;
    };
    const doneFor = (publicId: string | undefined, memberId: string | undefined, wanted: string) =>
      rows.filter((row) => {
        if (row.status !== "done" || step(row) !== wanted || row.prospectId === null) return false;
        const person = personOfProspect.get(row.prospectId);
        return person !== undefined && ((publicId !== undefined && person.publicId === publicId) || (memberId !== undefined && person.memberId === memberId));
      });
    const rowsFor = (publicId: string | undefined, wanted: string) =>
      rows
        .filter((row) => step(row) === wanted && row.prospectId !== null && personOfProspect.get(row.prospectId)?.publicId === publicId)
        .map((row) => `${row.idempotencyKey}=${row.status}`);

    const messageIndex = new Map<string, number>();
    for (const entry of log) {
      if (!SEND_KINDS.has(entry.kind)) continue;
      let wanted: string = entry.kind;
      if (entry.kind === "message") {
        const key = entry.memberId ?? entry.publicId ?? "?";
        const index = (messageIndex.get(key) ?? 0) + 1;
        messageIndex.set(key, index);
        wanted = index === 1 ? "message1" : "followup";
      }
      if (doneFor(entry.publicId, entry.memberId, wanted).length === 0) {
        violations.push({
          message: `LinkedIn got ${wanted === "message1" ? "a first message" : wanted === "followup" ? "a follow-up" : `a ${wanted}`} for ${entry.publicId ?? entry.memberId ?? "?"} with no done ${wanted} row in the ledger`,
          detail: { at: iso(entry.at), rows: rowsFor(entry.publicId, wanted) },
        });
      }
    }
    for (const row of rows) {
      const wanted = step(row);
      if (row.type === "message" && wanted === null) violations.push({ message: `message ledger row with an unknown step: ${row.idempotencyKey}` });
      if (row.status !== "done" || wanted === null || row.prospectId === null) continue;
      const person = personOfProspect.get(row.prospectId);
      const matches = log.filter(
        (entry) =>
          entry.kind === (wanted === "message1" || wanted === "followup" ? "message" : wanted) &&
          person !== undefined &&
          (entry.publicId === person.publicId || (person.memberId !== null && entry.memberId === person.memberId)),
      );
      const needed = wanted === "followup" ? 2 : 1;
      if (matches.length < needed) {
        violations.push({ message: `ledger row ${row.idempotencyKey} is done but LinkedIn shows ${matches.length} ${wanted === "followup" ? "app messages (a follow-up needs two)" : wanted}`, detail: { person: person?.publicId ?? null } });
      }
    }
    const done = rows.filter((row) => row.status === "done").length;
    return {
      id: 8,
      title: "The ledger agrees with LinkedIn",
      violations,
      notes: [`${rows.length} ledger rows, ${done} done`],
      checked: [
        { count: rows.length, what: "ledger rows" },
        { count: log.filter((entry) => SEND_KINDS.has(entry.kind)).length, what: "sends" },
      ],
    };
  }

  function campaignOf(prospect: ProspectFact): CampaignFact {
    const campaign = facts.campaigns.get(prospect.campaign);
    if (campaign === undefined) throw new Error(`no campaign ${prospect.campaign} in the facts`);
    return campaign;
  }
}

function describeRendered(rendered: Rendered): string {
  return rendered.kind === "text" ? rendered.text : `(${rendered.kind})`;
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.message}|${JSON.stringify(violation.detail ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
