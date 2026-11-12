# Invite, message and withdraw on the real site

Written 2026-11-12. **Nothing here has run on the live site.** The three write operations in
`src/linkedin/write/` were built and tested against saved pages and invented dialogs only. They are
not wired into the app: `src/worker/liveDriver.ts` keeps its read-only wrapper, whose writes throw.
No invitation, message or withdrawal may go out until the user has created a campaign with his own
text, approved its prospects, and the checklist below has been gone through.

## What was built

| File | What it does |
| --- | --- |
| `page.ts` | `WritePage`, the small interface the operations act through (load, count, click, type, clear, value, Escape, wait, clock), and `writePageFor(page)` over Playwright's `Page`. Controls are found by role and accessible name inside a scope; typing has human timing, and a line break is Shift+Enter, never Enter |
| `invite.ts` | `sendInvite(deps, person, note, guard)` |
| `message.ts` | `sendMessage(deps, person, text, expected)` |
| `withdraw.ts` | `withdrawInvite(deps, person, guard)`, from the sent-invitations page |
| `driver.ts` | `createWriteDriver(deps)`: the three as a `WriteDriver`, with the safety-stop latch of the read driver |
| `selectors.write.ts` | Scopes and wording, English and Italian. Every string not seen on a saved page is marked `// unverified` |
| `markup.ts` | Finds controls and open dialogs in saved HTML by the same role-and-name rules |
| `common.ts` | Paced, health-checked page loads; the deadline; save the page and throw `Unexpected` |
| `scriptedPage.ts`, `testPages.ts` | Test stand-in for the window, and pages built from fixtures |

To wire it later: one Playwright page gives both a `DriverPage` (`driverPageFor`) and a `WritePage`
(`writePageFor`); the read and write halves should then share one latch, so that a checkpoint seen
by a write also stops reads.

### How each operation decides

- **Invite.** Deadline; open the profile; health check; the profile must show the public id asked
  for and, when it shows one, the member id; Connect links in the top card must name that public id.
  Pending → `already_pending`, 1st degree → `already_connected`, both without a click. Connect in
  the top card, or More → Connect in the menu; no Connect in the menu → `not_offered` (menu closed).
  Then "Add a note" + type + check the box holds the note + Send, or "Send without a note". The
  invitation limit → `LimitHit` (dialog closed, nothing sent); a request for the person's email →
  `not_offered` (dialog closed); no free note left → `Unexpected`, nothing sent. `sent` only once no
  dialog is open and the profile's top card shows Pending. The deadline is read before the load,
  More, Connect, Add a note, typing and Send.
- **Message.** Deadline; open `/messaging/compose/?profileUrn=…&recipient=<member id>` (decision 16);
  `parseThread`; the same person check as `readThread`; clear any draft; compare the number of
  messages shown with `expected.messageCount` (`thread_changed`); deadline; type; the box must hold
  the text; read the conversation again, compare the count and the deadline again, then click Send.
  `sent` only once the conversation ends with a message from the user whose text is the same
  (`sameText`). A changed count or a passed deadline after typing clears the box.
- **Withdraw.** From the sent-invitations page, which is saved with its Withdraw control; a profile
  showing Pending is not. No row for the person → `not_pending`. Withdraw on their row, a
  confirmation dialog, deadline, confirm, and `withdrawn` only once the row is gone.

Anything not recognised at any step saves the page (`savePage`) and throws `Unexpected`; a login
wall, checkpoint or restriction met after a click throws its own error instead. A throw after the
final click means the result is not known; the engine checks LinkedIn before any retry.

## What the tests cover

`npx vitest run src/linkedin/write`: every result and refusal of each operation on the scripted page
built from fixtures; the deadline before every step (and a passed deadline before anything loads
nothing); the draft cleared; the count compared before typing and again before Send; no click or
typing when the page shows someone else; every unrecognised state saves the page and throws;
English and Italian wording. `chrome.test.ts` loads the saved profile, conversation and
sent-invitations pages into real Chrome (fresh non-persistent context, every request aborted,
pages put in with `setContent`, no navigation) and checks Playwright finds Connect, More, the
message box, Send and Withdraw, with the same counts as `markup.ts` finds in the saved HTML, and
that typing with Shift+Enter and clearing work in the message box.

## Checklist for the live site

For the user and the lead, with the dedicated window, before the first real send. Each item: what to
look at, what the code expects, where to change it if it differs. Items 1, 2, 12 and 16 are partly
seen on saved pages; everything else is invented. Save the page (`npm run live:capture` or the
browser's Save Page) at each step so fixtures can replace the `synthetic-*` ones in `fixtures/write/`.

1. **Connect in the top card.** Look at a 2nd-degree profile. Expected (seen 2026-11-11 on a later
   load): a link to `/preload/custom-invite/?vanityName=<public id>` labelled "Invite <name> to
   connect", text "Connect", inside the profile card holding the Contact info link, twice (two
   layouts, one hidden by a stylesheet). Check that clicking it opens a dialog over the profile and
   does not navigate to a separate page. Change: `selectors.write.ts` (`topCard`, `connect`),
   `invite.ts` (`inviteScreen`).
2. **Connect under More.** Look at a profile whose top card shows Follow and More. Expected: More
   opens an element with `role="menu"` (anywhere on the page) whose items have `role="menuitem"`, one
   named "Connect" or "Invite <name> to connect". Change: `selectors.write.ts` (`menu`, `more`,
   `connect`), `connectUnderMore` in `invite.ts`. Fixture: `synthetic-more-menu-*`.
3. **The dialog after Connect.** Expected: an open `<dialog>` (like the closed ones seen on 2026
   pages) or an element with `role="dialog"`, with buttons "Add a note" and "Send without a note".
   Change: `addNote`, `sendWithoutNote`, `dialog` in `selectors.write.ts`. Fixture:
   `synthetic-invite-choose-*`.
4. **The note box.** Expected: a text box inside the dialog and a button "Send" (or "Send
   invitation"). Look at the character counter: the code allows 300 (`noteMaxLength`, and the
   app's form). If a free account gets fewer, the box cuts the note, the code sees the box does not
   hold the whole note and sends nothing. Change: `sendInvitation`, `noteMaxLength`. Fixture:
   `synthetic-invite-note-*`.
5. **No free note left this month.** Expected: an upsell instead of the note box, with text such as
   "out of free personalized invitations". The code sends nothing and throws `Unexpected`. Look at
   the real wording; decide with the principal whether the app should then send without a note
   (that is an engine change). Change: `noteQuotaPhrases`. Fixture: `synthetic-invite-note-quota-en`.
6. **LinkedIn's invitation limit.** Expected: a dialog whose text holds "weekly invitation limit"
   (or another phrase in `limitPhrases`), after Connect or after Send. The code closes it and throws
   `LimitHit`, which raises a safety stop. Look at the wording and when it appears. Change:
   `limitPhrases`. Fixture: `synthetic-invite-limit-*`.
7. **Email required.** Expected: a dialog asking for the person's email ("To verify this member
   knows you, please enter their email"). The code closes it with Escape and returns `not_offered`.
   Change: `emailPhrases`. Fixture: `synthetic-invite-email-*`.
8. **After sending an invitation.** Expected: within 15 s, no dialog open and the top card's
   control reads "Pending" (or its aria-label starts "Pending" or "Withdraw invitation"), on the
   profile URL. If LinkedIn leaves the page on `/preload/custom-invite/`, or shows a dialog after
   sending (suggestions, "How do you know…"), the code throws `Unexpected` and the engine treats the
   invite as unknown. Change: `pending` and `pendingAction` in `parse/selectors.profile.ts`,
   `confirmSent` in `invite.ts`.
9. **Escape closes dialogs and menus.** The code presses Escape to close the email dialog, the
   limit dialog and the More menu, and waits for no dialog to be open. If Escape does nothing,
   click the dialog's Dismiss button instead (seen on 2026 dialogs, `aria-label="Dismiss"`).
   Change: `closeDialog` in `common.ts`.
10. **Withdraw.** On My Network → Manage invitations → Sent → People. Expected (seen): the row's
    control "Withdraw", aria-label "Withdraw invitation sent to <name>". Then (invented) a dialog
    with "Withdraw invitation" in its text and a "Withdraw" button; after confirming, the row
    disappears without a reload. Also look at how many rows the page loads: only loaded rows are
    seen, so an invitation further down returns `not_pending`, which the engine holds for review.
    Change: `withdraw`, `confirmWithdraw`, `withdrawPhrases`. Fixture: `synthetic-withdraw-confirm-*`.
11. **After sending a message.** Expected: within 15 s, without a reload, the compose pane ends with
    the user's message, drawn like earlier messages (name, profile link, body) so `parseThread`
    reads it with the text as typed. Look also at whether the address bar moves to
    `/messaging/thread/<id>/`. Change: `sendMessage` in `message.ts`; the thread parser if the
    markup differs.
12. **The message box.** Expected (seen): a `role="textbox"` element and a "Send" button inside
    `.msg-convo-wrapper .msg-form`, Send disabled while the box is empty. Check that typed keys
    enable Send, that Shift+Enter makes a line break whichever "Press Enter to send" setting is on,
    that Cmd+A then Backspace clears a draft, and whether LinkedIn restores a draft when the compose
    URL is opened again (the code clears it either way). Change: `messageForm`, `sendMessage`
    in `selectors.write.ts`; `clear` in `page.ts`.
13. **Italian wording.** None seen. Switch the interface to Italian (an account setting: ask the
    principal) and check every `it` string in `selectors.write.ts`: Collegati / "Invita <nome> a
    collegarsi", Altro, Aggiungi una nota, Invia senza nota, Invia, Ritira / "Ritira invito inviato
    a <nome>", and the limit, email, note-quota and withdraw phrases; also the Pending wording in
    `parse/selectors.profile.ts`.
14. **Is the invite note shown in the conversation after acceptance?** (Decisions 51 and 63.) After
    an invitation with a note is accepted, open the conversation by its compose URL and see whether
    the note appears as the user's first message. The thread check accepts it either way today;
    once known, make the rule exact in `src/engine/threadCheck.ts` (`judgeThread`, `judgeSend`).
15. **How a message with a link is redrawn.** Send (in the campaign flow) a message containing a URL
    and look at how the conversation shows it: the link text kept as typed, shortened, or with a
    preview card whose text joins the body. `sendMessage` confirms by `sameText`; if the text is
    redrawn differently, every message with a link ends `Unexpected` (result unknown) and is held
    for review. Change: `sameText` in `src/engine/threadCheck.ts` or the body text in `parse/thread.ts`.
16. **Re-inviting after a withdrawal is blocked.** (Decisions 47 and 63.) After a withdrawal, open
    the profile: does it show Connect, and what does Connect do (a message that the person cannot
    be invited again for about three weeks)? Decision 47 relies on this block. The code would meet
    that message as an unknown dialog and throw `Unexpected`. If it is a dialog, add its wording to
    `selectors.write.ts` and decide whether it is `not_offered`.
17. **Which of the two copies is visible.** The top card holds Connect, Message and More twice; the
    code clicks the first visible one. Check with the dedicated window at its usual size that
    exactly one copy is visible (Playwright: `locator.filter({ visible: true }).count()` is 1).
18. **Timing.** Each wait for LinkedIn to answer a click is 15 s (`timeoutMs`). Check that dialogs,
    Pending and a sent message appear well within that on the real connection.

<!-- src: saved pages under captures/ and fixtures/ (2026-11-11), decisions 13, 16, 46, 47, 51, 55, 63. -->
