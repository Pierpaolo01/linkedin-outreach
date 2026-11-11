# Opening the conversation with one person

Seen on the real account, English interface, 2026-11-11. No Italian run yet.

## What the driver does

`readThread({ memberId, publicId? })` loads

    https://www.linkedin.com/messaging/compose/?profileUrn=urn:li:fsd_profile:<memberId>&recipient=<memberId>

and reads the page. No click, no typing. The member id (`ACoA…`) is in the Message link of a
profile's top card and of each row of the connections list, so `viewProfile` and
`listRecentConnections` return it as `memberId`.

LinkedIn answers with the "New message" pane, the person on a recipient pill:

| Who | What the pane shows | Result |
| --- | --- | --- |
| A connection with no conversation yet | The pill, a profile card linking `/in/<vanity id>/`, no messages | `isNew: true`, no messages |
| A connection the user has written with | The pill and the latest messages under it; no profile card | The messages with senders, `isNew: false` |
| Not a connection (even with an earlier InMail conversation) | A new InMail form: no pill, "Use 1 of N InMail credits" | `Unexpected` (the parser refuses it) |

The third row is why `readThread` is only for 1st-degree connections, which is all the engine needs:
it reads a thread after an invitation was accepted.

## How the driver knows it is the right person

LinkedIn opens the newest conversation when it cannot open the one asked for, so the driver never
trusts the page blindly:

- a normal open conversation: the title bar's profile link must carry the member id asked for;
- the new-message pane with messages from the person: their sender link must carry that member id;
- the new-message pane where only the user has written, or nobody: no member id is on the page, so
  the address bar must still be the compose URL for that member, and in the empty case the profile
  card's vanity id must equal the `publicId` passed in.

Anything else is `Unexpected`, with the page saved in the data directory.

## Also tried

- **A conversation's own URL** (`/messaging/thread/<id>/`): works when known, but the saved markup
  of the messaging page holds no thread id per conversation, and the compose URL does not redirect
  to it (`threadUrl` came back null on every live read). Not needed.
- **Clicking Message on a profile**: opens an overlay on the profile page in different markup. Needs
  a click and a second parser. Not used.

## Not verified

- A connection with a long conversation: the pane shows the latest messages and a loader above
  them. Older messages are not read. The engine only needs to know whether the person has written.
- A conversation where only the user has written (the state after the engine's first message). The
  parser handles it by construction and by a synthetic fixture; it has not been seen live.
- Whether loading the compose URL marks unread messages as read. Assume it does.
- Italian wording on these pages.
