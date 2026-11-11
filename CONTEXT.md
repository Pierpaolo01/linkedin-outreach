# LinkedIn outreach

A local app that runs one user's LinkedIn outreach (invite, message after acceptance, one follow-up) through a dedicated Chrome window, and keeps every person and action in a local database.

## Language

### People

**Person**:
A LinkedIn member, stored once no matter how many campaigns find them. Identified by their public profile identifier.
_Avoid_: Lead, contact, member, user

**Prospect**:
A person inside one campaign, with a score, a stage and the texts sent to them.
_Avoid_: Lead, target, candidate

**Card**:
The summary of a person as LinkedIn shows it in a list (recommendations, search results, connections), before their profile is opened.
_Avoid_: Result, tile, item

**User**:
The owner of the LinkedIn account the app drives. One install has one user.
_Avoid_: Alex, operator, account owner

### Campaigns

**Campaign**:
One audience with its own targeting, scoring brief, templates and timings.

**Discovery**:
Collecting cards from a discovery source for a campaign.
_Avoid_: Scraping, crawling, sourcing

**Discovery source**:
Where a campaign's cards come from: a recommendations page or a people search.

**Scoring brief**:
The user's free-text description of who fits a campaign and who does not.
_Avoid_: Prompt, ICP

**Approval queue**:
Scored prospects waiting for the user to approve or reject them before any outreach.

**Sequence**:
The outreach steps for one prospect: invite, first message, follow-up.
_Avoid_: Cadence, flow, drip

**Step**:
One send in a sequence. A step is sent at most once per prospect.

**Stage**:
Where a prospect is in its lifecycle (found, scored, approved, invited, accepted, and so on).
_Avoid_: Status, state (status is for campaigns, actions and jobs)

**Stopped**:
A sequence ended early because the prospect replied or the user messaged them himself.

**Needs review**:
A prospect the app refuses to decide on by itself, held for the user with the reason.

**Suppression**:
A person who has been contacted once is never contacted again in any campaign, for the life of the install.
_Avoid_: Blacklist, dedupe

### Engine

**Action**:
One thing done on LinkedIn, recorded in the ledger whether it succeeded, failed or ended unknown.
_Avoid_: Event, operation, task

**Ledger**:
The permanent record of all actions. Limits are counted from it.

**Due work**:
What the engine should do next, worked out each tick from every prospect's stage and next-action time. Nothing is queued in a table.
_Avoid_: Job, task, queue

**Claim**:
Moving a step's ledger row from planned to in progress, in one transaction, before the driver acts. A step that was claimed is never sent blindly again.

**Reconcile**:
Checking LinkedIn for what really happened to an action whose result is unknown, before deciding to retry.

**Budget**:
The account-wide allowance of one action type per calendar day or week, shared by all campaigns. A spent budget defers work and resumes by itself.
_Avoid_: Quota, rate limit

**Safety stop**:
A halt of all LinkedIn activity that only the user can lift, raised when LinkedIn shows a login wall, checkpoint, CAPTCHA, warning or its own invitation limit.
_Avoid_: Pause (a pause is the user's choice on one campaign), error

**Working window**:
The days and hours, in the app's time zone, when the app may act on LinkedIn.

### LinkedIn

**Driver**:
The only part of the app that touches LinkedIn. One function per operation, one operation at a time.
_Avoid_: Scraper, bot, client

**Fake driver**:
A stand-in for the driver that simulates LinkedIn for tests and the engine simulation.

**Dedicated window**:
The visible Chrome window the app owns, with its own profile, where the user logs in to LinkedIn once.

**Session**:
The logged-in state of the dedicated window, as last observed (ok, logged out, checkpoint, restricted, search capped).

**Capture**:
A saved LinkedIn page (HTML and screenshot) holding real people's data. Never committed.

**Fixture**:
A capture with names, profile URLs and photos replaced, committed for parsing tests.
