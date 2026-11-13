/**
 * NOT VERIFIED ON THE LIVE SITE. Built against the saved sent-invitations page and an invented
 * confirmation dialog; docs/research/write-operations.md lists what to check before the first real
 * withdrawal.
 *
 * `withdrawInvite` works from the sent-invitations page rather than the profile: that page is
 * saved with its Withdraw control (seen 2026-11-11), while a profile showing Pending is not.
 */
import type { PersonRef, SendGuard, WithdrawResult } from "../driver";
import { parseSentInvitations } from "../parse/sentInvitations";
import { closeDialog, expiryOf, giveUp, hasOpenDialog, openPage, pastDeadline, readPage, timeoutOf, wordingOf, type WriteDeps } from "./common";
import { findAll, normalisedText, openDialogs, parseHtml } from "./markup";
import type { Target } from "./page";
import { sentRowOf, writeStructure } from "./selectors.write";

const SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

/**
 * NOT VERIFIED ON THE LIVE SITE. Withdraws the pending invitation to this person.
 *
 * Reads the clock before the page load, the click on Withdraw and the click that confirms (that
 * one after the hover and pause, immediately before the click itself), and returns "expired" past
 * `guard.notAfter` (closing the confirmation if it is open). "not_pending"
 * when the list shows no invitation to the person; only the rows the page has loaded are seen.
 * "withdrawn" only once the person's row is gone. Throws `Unexpected`, with the page saved, on
 * anything it does not recognise; after the confirming click a throw means the result is not known.
 */
export async function withdrawInvite(deps: WriteDeps, person: PersonRef, guard: SendGuard): Promise<WithdrawResult> {
  const { page } = deps;
  if (pastDeadline(page, guard)) return "expired";

  const html = await openPage(deps, SENT_URL);
  const cards = await readPage(deps, html, (shown) => parseSentInvitations(shown));
  const theirs = cards.filter((card) => card.publicId === person.publicId);
  if (theirs.length === 0) return "not_pending";
  if (theirs.length > 1) return giveUp(deps, "the list shows more than one invitation to the person");
  if (theirs[0]?.canWithdraw !== true) return giveUp(deps, "the person's invitation has no Withdraw control");

  const wording = wordingOf(html);
  const row = sentRowOf(person.publicId);
  const withdraw: Target = { roles: ["button", "link"], name: wording.withdraw, within: row };
  if ((await page.count(withdraw)) === 0) return giveUp(deps, "no Withdraw control was found on the person's row");
  if (pastDeadline(page, guard)) return "expired";
  await page.click(withdraw);

  const confirm: Target = { roles: ["button"], name: wording.confirmWithdraw, within: writeStructure.dialog };
  const asked = await page.waitFor((shown) => {
    const root = parseHtml(shown);
    const text = openDialogs(root).map(normalisedText).join(" ");
    return wording.withdrawPhrases.some((phrase) => text.includes(phrase)) && findAll(root, confirm).length > 0 ? true : undefined;
  }, timeoutOf(deps));
  if (asked === undefined) return giveUp(deps, "no confirmation appeared after Withdraw");
  // The clock is read after the hover and pause, immediately before the click itself.
  if ((await page.clickUnless(confirm, expiryOf(page, guard))) !== undefined) {
    await closeDialog(deps);
    return "expired";
  }

  const gone = await page.waitFor(
    (shown) => (!hasOpenDialog(shown) && shown.includes(writeStructure.sentScreen) && findAll(parseHtml(shown), { roles: ["link"], within: row }).length === 0 ? true : undefined),
    timeoutOf(deps),
  );
  if (gone === undefined) return giveUp(deps, "the invitation is still listed after confirming the withdrawal");
  return "withdrawn";
}
