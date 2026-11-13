/**
 * NOT VERIFIED ON THE LIVE SITE. Built against saved pages and invented dialogs only (the dialogs
 * after Connect are in no capture); docs/research/write-operations.md lists what to check before
 * the first real invitation.
 *
 * `sendInvite`: open the profile, make sure it is the person asked for, find Connect (in the top
 * card or under More), choose "Add a note" or "Send without a note" in the dialog, and return
 * "sent" only once the profile shows Pending.
 */
import type { InviteResult, PersonRef, SendGuard } from "../driver";
import { LimitHit, Unexpected } from "../errors";
import { savePage } from "../pageHealth";
import { profileUrlFor } from "../parse/card";
import { parseProfile } from "../parse/profile";
import { sameText } from "../../engine/threadCheck";
import {
  closeDialog,
  expiryOf,
  giveUp,
  openPage,
  pastDeadline,
  readPage,
  timeoutOf,
  tryParse,
  wordingOf,
  type WriteDeps,
} from "./common";
import { findAll, normalisedText, openDialogs, parseHtml } from "./markup";
import type { Target } from "./page";
import { writeStructure, type WriteWording } from "./selectors.write";

/** What the page shows after a click on the way to an invitation. */
type InviteScreen = "limit" | "email_required" | "note_quota" | "choose" | "note" | "pending";

/**
 * NOT VERIFIED ON THE LIVE SITE. Sends one invitation, with `note` or (null or blank) without one.
 *
 * Reads the clock before every step (the page load, opening More, Connect, Add a note, typing, Send;
 * for the clicks that can send, Connect, Send and Send without a note, after the hover and pause,
 * immediately before the click itself) and returns "expired" past `guard.notAfter`, closing any
 * dialog it opened. Clicks nothing unless
 * the profile is the person asked for (public id, and member id when the page shows one).
 * Throws `LimitHit` on LinkedIn's invitation limit (nothing was sent), and `Unexpected`, with the
 * page saved, on anything it does not recognise; after the click on Send a throw means the result
 * is not known.
 */
export async function sendInvite(deps: WriteDeps, person: PersonRef, note: string | null, guard: SendGuard): Promise<InviteResult> {
  const { page } = deps;
  const text = note === null || note.trim() === "" ? null : note;
  if (text !== null && text.length > writeStructure.noteMaxLength) {
    throw new Unexpected(`a note of ${text.length} characters does not fit LinkedIn's ${writeStructure.noteMaxLength}`);
  }
  if (pastDeadline(page, guard)) return "expired";

  const html = await openPage(deps, profileUrlFor(person.publicId));
  const profile = await readPage(deps, html, parseProfile);
  if (profile.publicId !== person.publicId || (profile.memberId !== null && profile.memberId !== person.memberId)) {
    return giveUp(deps, "the profile shown is not the person asked for");
  }
  if (connectLinkNamesSomeoneElse(html, person.publicId)) return giveUp(deps, "the Connect link names someone else");
  const wording = wordingOf(html);

  let connect: Target;
  switch (profile.connectionState) {
    case "pending":
      return "already_pending";
    case "connected":
      return "already_connected";
    case "can_connect":
      connect = { roles: ["button", "link"], name: wording.connect, within: writeStructure.topCard };
      if ((await page.count(connect)) === 0) return giveUp(deps, "the profile offers Connect, but no Connect control was found");
      break;
    case "connect_in_more":
    case "follow_only": {
      const fromMenu = await connectUnderMore(deps, wording, guard);
      if (fromMenu === "expired" || fromMenu === "not_offered") return fromMenu;
      connect = fromMenu;
      break;
    }
    case "unknown":
      return giveUp(deps, "the profile shows no Connect, Pending, Follow or Message");
    default: {
      const _exhaustive: never = profile.connectionState;
      return _exhaustive;
    }
  }

  if ((await page.clickUnless(connect, expiryOf(page, guard))) !== undefined) return closeAnd(deps, "expired");
  const screen = await page.waitFor((shown) => inviteScreen(shown, wording), timeoutOf(deps));
  switch (screen) {
    case undefined:
      return giveUp(deps, "nothing recognisable appeared after Connect");
    case "limit":
      return limitHit(deps);
    case "email_required":
      return emailRequired(deps);
    case "note_quota":
      return refuse(deps, "LinkedIn offers no personalised note now; nothing was sent");
    case "pending":
      // Sent at the click, with no dialog: right only when no note was asked for.
      return text === null ? "sent" : giveUp(deps, "the invitation went out at the click on Connect, without the note");
    case "note":
      if (text === null) return refuse(deps, "LinkedIn asked for a note where none was to be sent; nothing was sent");
      return withNote(deps, text, wording, guard);
    case "choose":
      if (text !== null) {
        if (pastDeadline(page, guard)) return closeAnd(deps, "expired");
        await page.click(inDialog(wording.addNote));
        const next = await page.waitFor((shown) => only(inviteScreen(shown, wording), ["note", "note_quota", "limit"]), timeoutOf(deps));
        if (next === undefined) return giveUp(deps, "the note box did not appear after Add a note");
        if (next === "limit") return limitHit(deps);
        if (next === "note_quota") return refuse(deps, "LinkedIn offers no personalised note now; nothing was sent");
        return withNote(deps, text, wording, guard);
      }
      if ((await page.clickUnless(inDialog(wording.sendWithoutNote), expiryOf(page, guard))) !== undefined) return closeAnd(deps, "expired");
      return confirmSent(deps, wording);
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
}

/** Types the note in the dialog's box, checks the box holds exactly it, and sends. Not verified on the live site. */
async function withNote(deps: WriteDeps, text: string, wording: WriteWording, guard: SendGuard): Promise<InviteResult> {
  const { page } = deps;
  const box = inDialog(undefined, "textbox");
  if (pastDeadline(page, guard)) return closeAnd(deps, "expired");
  await page.type(box, text);
  // A box with a shorter limit than ours cuts the note silently.
  if (!sameText(await page.value(box), text)) return refuse(deps, "the note box does not hold the note as typed; nothing was sent");
  if ((await page.clickUnless(inDialog(wording.sendInvitation), expiryOf(page, guard))) !== undefined) return closeAnd(deps, "expired");
  return confirmSent(deps, wording);
}

/** After the click on Send: "sent" only once the dialog is gone and the profile shows Pending. Not verified on the live site. */
async function confirmSent(deps: WriteDeps, wording: WriteWording): Promise<InviteResult> {
  const after = await deps.page.waitFor((shown) => only(inviteScreen(shown, wording), ["pending", "limit", "email_required"]), timeoutOf(deps));
  if (after === "pending") return "sent";
  if (after === "limit") return limitHit(deps);
  if (after === "email_required") return emailRequired(deps);
  return giveUp(deps, "the profile does not show Pending after sending the invitation");
}

/** Opens More and finds Connect in its menu; "not_offered" (menu closed again) when it holds none. Not verified on the live site. */
async function connectUnderMore(deps: WriteDeps, wording: WriteWording, guard: SendGuard): Promise<Target | "expired" | "not_offered"> {
  const { page } = deps;
  const more: Target = { roles: ["button"], name: wording.more, within: writeStructure.topCard };
  if ((await page.count(more)) === 0) return giveUp(deps, "the profile offers no Connect and no More button");
  if (pastDeadline(page, guard)) return "expired";
  await page.click(more);
  const menuItems: Target = { roles: ["menuitem", "button", "link"], within: writeStructure.menu };
  const opened = await page.waitFor((shown) => (findAll(parseHtml(shown), menuItems).length > 0 ? true : undefined), timeoutOf(deps));
  if (opened === undefined) return giveUp(deps, "the More menu did not open");
  const connect: Target = { ...menuItems, name: wording.connect };
  if ((await page.count(connect)) === 0) {
    await page.dismiss();
    return "not_offered";
  }
  return connect;
}

/** What the page shows now: a dialog it knows, a profile showing Pending, or undefined. Not verified on the live site. */
function inviteScreen(html: string, wording: WriteWording): InviteScreen | undefined {
  const root = parseHtml(html);
  const dialogs = openDialogs(root);
  if (dialogs.length === 0) {
    return tryParse(html, parseProfile)?.connectionState === "pending" ? "pending" : undefined;
  }
  const text = dialogs.map(normalisedText).join(" ");
  const says = (phrases: readonly string[]) => phrases.some((phrase) => text.includes(phrase));
  if (says(wording.limitPhrases)) return "limit";
  if (says(wording.emailPhrases)) return "email_required";
  if (says(wording.noteQuotaPhrases)) return "note_quota";
  const has = (target: Target) => findAll(root, target).length > 0;
  if (has(inDialog(wording.addNote)) && has(inDialog(wording.sendWithoutNote))) return "choose";
  if (has(inDialog(undefined, "textbox")) && has(inDialog(wording.sendInvitation))) return "note";
  return undefined;
}

/** Not verified on the live site. */
function only<T extends string>(value: T | undefined, accepted: readonly T[]): T | undefined {
  return value !== undefined && accepted.includes(value) ? value : undefined;
}

/** Not verified on the live site. */
function inDialog(name: RegExp | undefined, role: "button" | "textbox" = "button"): Target {
  return name === undefined ? { roles: [role], within: writeStructure.dialog } : { roles: [role], name, within: writeStructure.dialog };
}

/** A Connect link in the top card carries `vanityName=<public id>`; any other id there means another person's card. Not verified on the live site. */
function connectLinkNamesSomeoneElse(html: string, publicId: string): boolean {
  const links = findAll(parseHtml(html), { roles: ["link"], within: writeStructure.topCard })
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.includes(writeStructure.connectLinkHref));
  return links.some((href) => {
    const vanity = new URL(href, "https://www.linkedin.com").searchParams.get("vanityName");
    return vanity !== null && vanity !== publicId;
  });
}

/** LinkedIn's invitation limit: the page is saved, the dialog closed, and nothing was sent. Not verified on the live site. */
async function limitHit(deps: WriteDeps): Promise<never> {
  const artifacts = await savePage(deps.page, await deps.page.content(), "unknown", deps.health ?? {});
  await closeDialog(deps);
  throw new LimitHit(`LinkedIn shows its invitation limit; nothing was sent. Saved html ${artifacts.html}`, { artifacts });
}

/** LinkedIn wants the person's email: Connect is not offered to this user. Not verified on the live site. */
async function emailRequired(deps: WriteDeps): Promise<InviteResult> {
  if (!(await closeDialog(deps))) return giveUp(deps, "the email dialog did not close");
  return "not_offered";
}

/** A dialog the invite cannot go through: saved as shown, closed, then `Unexpected`. Not verified on the live site. */
async function refuse(deps: WriteDeps, message: string): Promise<never> {
  const artifacts = await savePage(deps.page, await deps.page.content(), "unknown", deps.health ?? {});
  await closeDialog(deps);
  throw new Unexpected(`${message}. Saved html ${artifacts.html}`, { artifacts });
}

/** Closes whatever dialog or menu is open, without waiting, and returns the result. Not verified on the live site. */
async function closeAnd(deps: WriteDeps, result: InviteResult): Promise<InviteResult> {
  await deps.page.dismiss();
  return result;
}
