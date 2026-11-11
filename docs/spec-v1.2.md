# LinkedIn outreach tool: technical specification and implementation plan

ResultLabs · v1.2 draft · 2026-11-11 · Updated after the discovery call with Alex. For principal review and a separate build session.

Source: the principal's design and two grilling rounds, plus the supplied 11 November discovery-call transcript. Call citations below refer to [the recording](https://fathom.video/share/fVYVQCzoNX_dShkiH1m4JKsenTXB8fA2); selected source passages are retained in `Efforts/inbox/2026-11-11-alex-discovery-call.md`. This version supersedes v1.1 for implementation; the original Markdown and PDF remain historical. Section 16 lists the discovery changes; section 17 records the principal’s input clarification. Source: `Efforts/inbox/2026-11-11-alex-app-inputs-clarification.md`. Unconfirmed settings remain proposals, not client decisions.

## 1. What we are building

A local web app that runs Alex's LinkedIn outreach for him. It reproduces his manual process:

1. Send a connection request (no note unless the campaign has one).
2. One to two days after the request is accepted, send a short message.
3. If there is no reply, send one follow-up after another one to two days; calendar/working-day treatment remains to confirm (Alex, 4:06).

The app finds and scores prospects from LinkedIn recommendations or search, using his targeting, and lets him approve them (or auto-approves them). It drives a dedicated Chrome window that stays logged into his free LinkedIn account. It keeps every person, campaign, message and action in a local database, so it resumes correctly after a sleep, reboot or crash.

**Done** means Alex has it set up on his MacBook Air and campaigns are running. Qualification and rendered messages must first pass a joint sample review; the size and pass criteria of that sample remain to agree.

### Alex's workflow and baseline

Alex serves local business owners through his main agency and hotel businesses through Basta Ota (4:06). Keep targeting and copy separate by campaign; construction is an example, not the exclusive niche. His recent discovery process starts with LinkedIn recommendations, while earlier prospecting used known owner or company names (8:48).

He reports 15–20 connection requests and roughly 10–15 messages per day, with a manual session taking approximately 30–60 minutes (5:00; transcript wording is incomplete). Whether message counts include follow-ups needs confirmation. He reports around two replies per ten messages, with many responses arriving after the follow-up (4:06, 13:36). These are recollections, not verified analytics. Call conversion is unresolved: “50%” of replies and later “one to two” calls per 100 people do not reconcile (13:36–14:00). Do not project calls, revenue or time saved from these estimates.

**Not in scope:** SaaS or multi-tenant use; a reply inbox or reply notifications (Alex's LinkedIn app notifies him); Sales Navigator; InMail; CRM integrations; VPS deployment (possible later, not optimised for). Each additional user, including the principal, runs a separate install.

## 2. Decisions so far

| Topic | Decision |
| --- | --- |
| LinkedIn access | Our own browser automation (Playwright) on a dedicated, persistent Chrome profile. No third-party connector |
| Account risk | Earlier acceptance was reported by the principal. Reconfirm after correcting the call's ‘no risk’ assurance; local operation cannot guarantee account safety (16:14) |
| Where it runs | Alex's MacBook Air confirmed (12:18–12:44); retain earlier cross-platform requirement, with Mac onboarding first |
| LinkedIn plan | Non-Premium personal account confirmed (18:46) |
| Install / operate | Alex asks his AI coding tool (Claude Code or Codex, agnostic) to clone, set up, start, update and troubleshoot. Repo carries instructions written for that AI |
| Stack | Node.js + TypeScript + SQLite. No Docker, no database server |
| Startup / sleep | Starts automatically at login; keeps the computer awake while a campaign is active; resumes due work spread across the working window, never in a burst |
| Browser window | Visible, minimisable window owned by the app; Alex logs in once there and otherwise leaves it alone |
| Security checks | Any logout, checkpoint, CAPTCHA or warning stops all campaigns and shows a banner. Never bypassed automatically |
| Prospect discovery | Recommendations first in his recent workflow; search by owner/company name also supported (8:48). Exact recommendation surface and location rules still need examples |
| Scoring | AI scores recommendation/search cards; matching or ambiguous profiles may be opened. Industry and business-size judgments retain their evidence |
| Approval | Prospects are batched for approval once the batch size is reached or the discovery source is exhausted. Optional full-auto mode per campaign, with a score threshold |
| Volume | Configurable; start at proposed 15 invites/day and 10 total messages/day, informed by Alex's reported manual volume |
| Messages | Templates with variables (AI may fill/clean them); optional AI personalisation per campaign; delays configurable; empty invite-note field = no note |
| Stop rules | Any reply from the lead, or any message Alex sends that lead himself, stops the sequence. Unaccepted invites withdrawn after 21 days (configurable) |
| Exclusions | Never contact the same person twice across campaigns; skip 1st-degree connections |
| Multiple campaigns | Share one account-wide budget, taking turns (round-robin) |
| AI provider | Alex uses Claude Code (17:47–17:58). Retain provider adapter; subscription entitlement and API fallback budget remain to verify |
| UI language | English |
| Testing | Saved-page fixtures in development; live testing on the principal's own LinkedIn account before Alex |

## 3. Architecture

One Node process with three parts, plus the Chrome window it controls:

```
 Browser tab (localhost:4747)            Dedicated Chrome window (visible)
          │  HTTP/JSON                              ▲  Playwright
          ▼                                         │
 ┌─────────────────────────── Node app ────────────┴──────────────┐
 │  Web server + API   ─────►  SQLite (data dir)  ◄─────  Worker  │
 │  (UI, campaign CRUD,         campaigns, people,        scheduler│
 │   approvals, settings)       prospects, actions,       + rate   │
 │                              jobs, limits, log         limiter  │
 │                                    ▲                      │     │
 │                                    └──── AI adapter ◄─────┘     │
 │                                  (claude CLI / codex CLI / API) │
 └─────────────────────────────────────────────────────────────────┘
```

- **The UI never touches LinkedIn.** It reads and writes the database. The worker is the only thing that drives the browser, one action at a time, and records the result. This is the "database populates the UI" loop.
- **Single worker, single browser context.** A human only does one thing at a time; so does the app. This also removes most concurrency problems.
- **Why not n8n:** n8n can't hold a logged-in browser or a per-person state over weeks, and it would add a second runtime Alex has to install. The scheduler here is a table of due jobs in SQLite.
- **Data directory** sits outside the repo, so updates never touch data:
  - macOS: `~/Library/Application Support/linkedin-outreach`
  - Windows: `%APPDATA%\linkedin-outreach`
  - Linux: `~/.local/share/linkedin-outreach`

  It holds `app.db`, `backups/`, `chrome-profile/`, `screenshots/`, `logs/` and `secrets.json`.
- **Network:** the server binds to `127.0.0.1` only. No login screen is needed locally (optional password setting for later VPS use).

### Qualification and message quality

Alex prioritises owner-operated local businesses, generally below roughly 50 employees, with room for larger firms that fit (9:56–12:01). Matching an owner's surname to a company name is a positive clue, not proof of size. His legal-form exclusion was transcribed unclearly as “S.A.P.A.”; do not implement a legal-form blacklist from that fragment.

For each candidate retain the signals supporting owner status, business activity, location and estimated size. Unknown size is not an automatic rejection. Route ambiguous cases to review. Alex sometimes checks a company's website to clarify what it does and where it operates (9:56): proposed first version lets him attach/confirm that evidence during review; automated external website research is a separate scope decision.

Personalisation must preserve the detail Alex values: a supported construction-company classification can select construction-specific copy, but a company name alone cannot establish its services. Add `{{industry}}` to supported template variables, with evidence or a generic fallback approved by Alex. If an industry-specific promise cannot be supported, require review rather than inventing a claim. Approval should show both qualification evidence and the final message preview (7:22–8:00).

### Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript, `tsx` for running | One install on every OS |
| Server | Fastify | Small, typed |
| UI | React + Vite, built during setup, served by Fastify; Tailwind + shadcn/ui | One port, no separate dev server for Alex |
| Database | SQLite via `better-sqlite3` (prebuilt binaries for Mac/Win/Linux), WAL mode; Drizzle ORM + migrations | A single file; survives crashes |
| Browser | Playwright `launchPersistentContext` with `channel: "chrome"` (installed Google Chrome), falling back to Playwright's Chromium | Real Chrome looks most like a normal user; persistent profile keeps the login |
| AI | Provider adapter (section 8) | Subscription or API key |
| Validation | zod for config, AI output and API payloads | Rejects bad AI output before it reaches LinkedIn |
| Tests | Vitest; Playwright against saved HTML fixtures; GitHub Actions on macOS, Windows, Linux | Catches cross-OS setup breaks |

## 4. Data model (SQLite)

All timestamps are stored in UTC; working hours are computed in Alex's time zone (setting, default Europe/Rome **[after call: confirm]**).

- **settings**: key/value: time zone, working days/hours, limits, AI provider, keep-awake, batch size defaults.
- **session_state**: LinkedIn status (`unknown | ok | logged_out | checkpoint | restricted | search_capped`), last check, last error, screenshot path.
- **campaigns**:
  - id, name, status (`draft | finding | awaiting_approval | running | paused | completed | archived`)
  - targeting: discovery_source (`recommendations | search`), source URL/surface, search filters, keywords, location and campaign-specific exclusions
  - scoring brief (free text: who fits, who doesn't), score threshold, auto_approve, open_profile_threshold
  - target prospect count, batch size
  - templates: invite_note (nullable), first_message, follow_up; ai_personalise flag + personalisation instructions
  - timings: accept→message delay min/max hours (default 24–48), follow-up delay min/max hours (proposed 24–48); working-window policy configurable, withdraw-after days (default 21)
  - weight (share of the budget), created/updated
- **people**: global and unique per LinkedIn member (public identifier/URN):
  - profile URL, full name, cleaned first name, headline, title, company, location, connection degree, discovery source, industry/size evidence with source and confidence, raw card/profile JSON, first_seen
  - `do_not_contact` flag
- **prospects** (a person in a campaign):
  - campaign_id, person_id, AI score, reason, model used, stage (section 5), stop_reason, next_action_at
  - rendered texts as sent: invite note, first message, follow-up, AI line
  - timestamps: found, approved, invited, acceptance_observed, first_message_sent, follow_up_sent, reply_detected, closed
  - Lifetime suppression keyed by person_id: once contacted, archiving a campaign never makes the person eligible again. Keep one active prospect per person as an additional constraint; historical records may remain across archived campaigns. This fixes v1.0’s mismatch between “never twice” and active-only uniqueness.
- **actions**: the ledger of every LinkedIn action:
  - type (`search_page | recommendation_page | profile_view | invite | withdraw | message | thread_check | connections_check | health_check`), prospect/campaign ids
  - status (`planned | in_progress | done | failed | unknown`), unique `idempotency_key` (e.g. `invite:<prospect>`, `message1:<prospect>`), started/finished, error, screenshot
  - Rate limits are counted from this table, so they survive restarts.
- **jobs**: the scheduler queue: kind, payload, run_after, attempts, status, locked_at.
- **event_log**: human-readable audit trail shown in the UI ("Invite sent to Marco Rossi").

Backups: copy `app.db` daily using SQLite's online backup; keep 7.

## 5. Prospect lifecycle

```
found ──AI──► scored ──below threshold──► rejected
                 │
                 ├─auto-approve & ≥ threshold──┐
                 ▼                              ▼
         pending_approval ──Alex──► approved ──► invited ──► accepted ──(wait 24–48h)──► message_sent ──(wait N days)──► follow_up_sent ──► completed
                 │                                  │                                  │                                  │
                 └─► rejected by Alex               └─(21 days)─► withdrawn            └────────── reply / Alex messaged ─┴─► stopped
Any stage ─► needs_review (unexpected page, already connected, existing conversation, unknown send result)
```

Rules:

- Before **any** message send, the worker opens the conversation and checks two things: no message from the lead, and no message from Alex since the last automated step. If either exists, the prospect moves to `stopped` (reason `replied` or `manual_takeover`).
- On `accepted`, it schedules the first message at a random point between the min and max delay, moved to the next working window.
- Search results already at 1st degree are never stored as prospects. If the invite step finds someone is already connected or already pending, the prospect goes to `needs_review` rather than being messaged.
- Template edits apply only to steps not yet sent; sent texts are frozen on the prospect.
- Pausing a campaign stops scheduling new steps; in-flight actions finish. Resuming re-checks each prospect before acting.

## 6. Worker, scheduling and rate limiting

**Loop:**

1. Every ~30 s: is the app inside working hours, is the session OK, and are we past the human-pause timer?
2. Pick the next due job in priority order:
   1. health and acceptance checks
   2. follow-ups
   3. first messages
   4. invites
   5. profile views
   6. discovery pages (search or recommendations)

   Within each type, campaigns take turns (round-robin, weighted).
3. Ask the limiter whether the budget allows it. If not, defer the job to the next window.
4. Run the job, write an action row, and update the prospect.
5. Sleep a random human gap before the next action.

**Pacing (defaults, all configurable):**

| Setting | Default |
| --- | --- |
| Working days/hours | Mon–Fri 09:00–18:00, local time zone |
| Gap between actions | random 45–180 s |
| Breaks | random 10–30 min break every 8–15 actions |
| Invites | 15/day, 80/week (proposed; daily value informed by Alex, weekly value remains an assistant default) |
| Profile views | 40/day (guess) |
| Messages (first + follow-up) | 10/day total (proposed; Alex reports 10–15, inclusion of follow-ups unconfirmed) |
| Discovery pages (search + recommendations) | 10/day shared (proposed) |
| Warm-up | invites start at 5/day and rise by 2/day to the configured limit |

**Global budget.** Limits are account-wide: all campaigns draw from one budget, counted from the `actions` table over rolling day and week windows. When a budget is spent, jobs of that type wait for the next window. Campaigns don't change state; the UI shows "Daily invite limit reached, resumes tomorrow 09:00". This is automatic and needs no human action.

**Safety stop.** This is separate from the budget and needs a human to resume. Triggers:

- logged out or a login wall
- a checkpoint/CAPTCHA page
- a "restricted" or warning banner
- an invitation-limit message from LinkedIn
- three consecutive unexpected-page failures

Effect: every campaign pauses, `session_state` records the reason and a screenshot, and a red banner tells Alex what to do. After an invitation-limit message, invites stay off for 7 days (configurable) even after resume.

**Restarts and sleep.**

- On startup, any action left `in_progress` becomes `unknown`. Each one is reconciled before retrying: an invite by checking the person's profile/sent invitations, a message by reading the thread. Sends are never blindly retried.
- Missed work is not "caught up". Due jobs keep their order and flow through the normal pacing and budgets, so a laptop that was off for 3 days produces a normal day of activity, not three days at once.

**Not measurable:** what Alex does by hand on LinkedIn also counts towards LinkedIn's view of the account. The settings screen says so and advises lowering limits if he also prospects manually.

## 7. LinkedIn browser driver

A single module, `linkedin/`, with one function per operation. Every function:

1. starts with a page-health check
2. uses role/text locators kept in one selector file
3. types and scrolls with human-like timing
4. returns typed data, or throws a typed error (`LoggedOut`, `Checkpoint`, `Unexpected`, `LimitHit`, `SearchCapped`)

On any unexpected page it saves a screenshot plus HTML and stops. It does not let an AI improvise clicks.

| Operation | How |
| --- | --- |
| `ensureSession()` | Open feed; detect logged-in vs login wall vs checkpoint vs restriction banner |
| `searchPeople(url, page)` | Load a people-search URL; parse result cards (name, headline, location, degree, profile URL, current company if shown). Detect the monthly commercial-use search cap and set `search_capped` |
| `viewProfile(url)` | Open profile; parse title, company, about, recent experience, degree, whether Connect is available or hidden under More |
| `sendInvite(url, note?)` | Connect → "Send without a note", or "Add a note" with the rendered note (300-char limit, free accounts get only a few per month). Detect "pending", "already connected", "email required" and limit dialogs |
| `listRecentConnections()` | My Network → Connections, sorted by recently added; first page(s). Run 3×/day to detect acceptances. Cheap: one page, not one visit per prospect |
| `readThread(url)` | Open the conversation with a person; return messages with sender and time |
| `sendMessage(url, text)` | Open message box from the profile or existing thread, re-check the thread, type, send, confirm the message appears |
| `withdrawInvite(url)` | Sent invitations page or profile → Withdraw |

Considerations:

- **LinkedIn interface language.** If Alex's LinkedIn is in Italian, text locators differ. Selectors will be written for English and Italian from the start, keyed by the page's `lang` attribute. **[after call: confirm his interface language]**
- **Recommendation discovery.** Add `listRecommendations(surface, cursor)` with saved-page fixtures, typed cards and deterministic navigation. Confirm which recommendation page Alex actually uses before fixing selectors. Reuse scoring, deduplication and account-wide discovery budgets. Persistent `discovery_runs` track source, cursor, seen people and exhaustion so restarts do not repeat discovery indefinitely. Acceptance of an invitation is an observed activity signal; it is not a promised response or sales intent.
- **Search input.** For search-based campaigns, use a search URL: Alex applies free-search filters on LinkedIn, then pastes the URL into the campaign. The filters include connection degree, location, current/past company, industry, school, profile language and keyword fields (title, company, first/last name). Keep search as an alternative; a filter builder can follow later. Alex’s recent recommendations workflow must not depend on him supplying a search URL.
- **Fixtures.** Every parsed page has saved-HTML fixtures with tests, so a LinkedIn UI change shows up as a failing test with a clear message rather than strange behaviour.

## 8. AI layer

**Provider adapter, one interface, four backends** (chosen in Settings, with a Test button):

1. `claude` CLI in headless mode (`claude -p`, JSON output), using Alex's Claude subscription.
2. `codex exec` CLI, using his ChatGPT/Codex subscription.
3. Anthropic API key.
4. OpenAI API key.

The CLI backends need the tool installed and logged in, which it will be if that is the AI he installs with. Check each provider's current terms on running automated jobs through a subscription before relying on it; API keys are the fallback.

**AI tasks:**

| Task | Input → output (zod-validated JSON) | Notes |
| --- | --- | --- |
| Score card | recommendation/search card + campaign scoring brief → `{score 0–10, reason, open_profile: bool}` | Batched (e.g. 10 cards per call) to cut cost |
| Score profile | full profile + brief → `{score, reason}` | Only for cards at or above the open-profile threshold |
| Clean variables | raw name/company → `{first_name, company_short}` | "Dott. Marco Rossi 🚀 \| Growth" → "Marco". Also used without personalisation |
| Personalise | profile + evidenced industry + template + campaign instructions → `{line, evidence}` | Only if enabled; max length; industry-specific wording must use supported facts. No invented services, results or business problems |

**Fallbacks:**

- If AI is unavailable, scoring jobs wait and variables fall back to parsed fields.
- No message is sent with an empty or unresolved `{{variable}}`; the prospect goes to `needs_review`.
- AI never decides whether to send. That is always the state machine and the limits.

## 9. Campaign inputs and templates

**Alex supplies and edits these values in the app.** Timing, volume, message copy and targeting criteria are product inputs, not fixed build requirements or prerequisites for another discovery call. Proposed numbers below are editable starting values. The UI persists changes and validates them before campaign activation.

The campaign wizard has six steps:

1. **Name.**
2. **Targeting:** recommendations or LinkedIn search URL(s)/filters, target number of prospects and campaign-specific audience rules.
3. **Targeting criteria and scoring brief:** Alex enters who fits and who does not, including roles/ownership, industries, geography, company-size preferences, positive signals and exclusions. The AI scores against these campaign inputs. Good/bad prospect examples are optional supporting inputs, not mandatory data Alex must provide before development.
4. **Approval:** batch size (default 25), auto-approve on/off, score threshold (default 7), open-profile threshold (default 6).
5. **Messages:**
   - optional invite note (empty means no note)
   - first message and follow-up templates using `{{first_name}}`, `{{company}}`, `{{title}}`, `{{location}}`, `{{industry}}` and `{{ai_line}}`
   - Alex writes and edits the message templates himself; personalisation on/off plus his instructions control optional AI-generated details
   - live preview against three real found prospects
6. **Timings and volume:** Alex enters acceptance-to-message and follow-up delay ranges, calendar/working-day treatment and withdrawal age. Account-wide Settings expose daily/weekly invitation limits and message, profile-view and discovery budgets; all campaigns share them. The proposed 24–48-hour delay and 10-total-messages/day budget are prefilled editable values, never fixed limits hidden in code. Settings changes update unsent work through the scheduler; sent history remains unchanged and budget counters are not reset. Lowering a limit below current usage defers further actions until budget is available.

Review, then Start. Starting runs discovery; sending begins only after approval (or immediately for auto-approved prospects).

## 10. Dashboard screens (English)

1. **Home:** session status light, today's usage against each limit, active campaigns, items that need Alex (approvals, needs_review, safety stop).
2. **Campaigns:** list with status, funnel counts and pause/resume.
3. **Campaign detail:** funnel (found → approved → invited → accepted → messaged → replied); prospect table with stage, score, reason, next action and link to profile; edit templates/timings.
4. **Approval queue:** batch cards with score and reason; approve all, approve or reject one, filter by score.
5. **Needs review:** prospects the app wouldn't decide on, each with the reason and a screenshot.
6. **Activity log:** every action with its time and result.
7. **Stats:** per campaign: acceptance rate, reply rate (replies ÷ first messages), time to accept, invites withdrawn. Doubles as data for the principal's content.
8. **Settings:** working hours/time zone, limits and warm-up, AI provider and test, keep-awake, LinkedIn window (open/re-login), CSV export, backups.

## 11. Repo, setup and operation by AI

```
linkedin-outreach/
  AGENTS.md            # setup / start / update / troubleshoot runbook for the AI (CLAUDE.md points to it)
  README.md            # human summary
  package.json         # scripts below
  scripts/             # setup, doctor, service install/uninstall, keep-awake helpers per OS
  src/server/  src/worker/  src/linkedin/  src/ai/  src/db/  src/ui/
  fixtures/            # saved LinkedIn HTML for tests
```

| Command | Does |
| --- | --- |
| `npm run setup` | Checks Node version and Chrome, installs dependencies and Playwright browser fallback, creates the data dir, runs migrations, builds UI |
| `npm start` | Starts server + worker, opens `http://localhost:4747` |
| `npm run service:install` / `service:uninstall` | Auto-start at login: launchd agent (macOS), Task Scheduler logon task (Windows), systemd user unit (Linux) |
| `npm run update` | Back up the DB, `git pull`, install, migrate, rebuild, restart the service |
| `npm run doctor` | Prints a diagnosis the AI can act on: versions, service state, DB integrity, session state, last errors, log tail |

- **Keep-awake** while a campaign is running and within working hours: `caffeinate -i` (macOS), `SetThreadExecutionState` via PowerShell (Windows), `systemd-inhibit` (Linux).
- **AGENTS.md** gives the AI exact steps for each request Alex might make ("set it up", "it stopped", "update it", "back up my data"). It forbids editing code or data on his machine unless he asks, and forbids deleting the data directory.
- **Prerequisites** Alex's AI installs if missing: Node 22 LTS, Git, Google Chrome.

## 12. Failure handling

| Situation | Behaviour |
| --- | --- |
| Computer sleeps / restarts / app crashes | Resume from DB; reconcile `in_progress` actions; normal pacing, no burst |
| Logged out, checkpoint, CAPTCHA, warning | Safety stop of all campaigns; banner + screenshot; Alex logs in in the window, presses Resume |
| LinkedIn invitation-limit message | Safety stop; invites disabled 7 days |
| Search cap reached | Discovery pauses until the next month (shown with a date); sequences for existing prospects continue |
| Unexpected page / selector broken | Screenshot + HTML saved, prospect to `needs_review`; three in a row triggers a safety stop. Alex asks his AI to run `doctor` and report to the principal |
| Send result unknown (timeout) | Check thread/invite state before any retry |
| Lead replies, or Alex messages them | Sequence stops at the next check or at the pre-send check, whichever comes first |
| AI provider down | Scoring/personalisation wait; nothing else blocked |
| DB corruption | Restore from the latest daily backup (`doctor` explains how) |

## 13. Implementation plan

Build in slices that each run end to end. Estimates below are carried forward from v1.0, assume one developer and require revision for the added discovery/qualification work; they are not commitments. The build happens in a separate venture repository and session, not in this vault.

| # | Slice | Scope | Exit evidence | Est. |
| --- | --- | --- | --- | --- |
| 0 | Skeleton & setup | Repo, TypeScript, Fastify + Vite UI shell, SQLite + migrations, data dir, `setup` / `start` / `doctor`, AGENTS.md, CI on 3 OSes | A fresh Claude Code and a fresh Codex each set it up from the repo URL alone on Mac and Windows | 1–2 d |
| 1 | Core engine with fake LinkedIn | Schema, prospect state machine, job scheduler, limiter, pacing, working hours, restart reconciliation, against a fake driver | Simulated 3-week campaign with restarts mid-run: no duplicate sends, limits respected, no catch-up burst | 2–3 d |
| 2 | Browser session & discovery | Persistent Chrome, login/health detection, recommendation + search discovery, profile parsing, EN/IT selectors, persistent discovery cursors and fixtures | On the principal's account: log in once, survive restart, parse recommendation and search fixtures plus 10 profiles; verify the actual recommendation surface | 2 d |
| 3 | Outreach actions | Invite (with/without note), recent-connections check, thread read, send message, withdraw, limit/cap detection | On the principal's account at low volume: full invite → accept → message → follow-up on 3–5 consenting test contacts; reply stops it | 2–3 d |
| 4 | AI layer | Adapter (claude CLI, codex CLI, Anthropic, OpenAI), scoring, variable cleaning, personalisation, validation | Alex reviews good/bad sample qualifications and evidenced industry copy; provider tests pass | 1–2 d |
| 5 | Dashboard | All screens in section 10, campaign wizard with preview, approval queue, CSV export | Principal runs a campaign end to end from the UI only | 2–3 d |
| 6 | Always-on & ops | Auto-start service per OS, keep-awake, daily backups, `update`, banner flows | Reboot, sleep and update on Mac + Windows without data loss | 1–2 d |
| 7 | Pilot on principal's account | 1–2 weeks of a real small campaign | No safety stops from bugs; limits and stop rules behave; findings fixed | 1–2 wk calendar |
| 8 | Alex onboarding | His AI installs it on his machine; he logs in and creates his first campaign on a call; screen-recorded with his permission | **Done:** Alex has it set up and running | ½ d |

Earlier v1.0 estimate: roughly 11–17 developer days plus the pilot period. Recommendations discovery and evidence-based personalisation expand the work; re-estimate after inspecting the actual recommendation surface. The old range is not a renewed commitment.

**Acceptance evidence:** principal tests recommendation and search discovery, both campaign audiences, grounded industry copy, reply/manual-takeover stops, restart recovery and shared limits before Alex onboarding. On Alex’s Mac, demonstrate setup through Claude Code, login, prospect/message review, pause/resume and a paced end-to-end campaign. Verify against real examples before enabling automatic approval; this is a proposed rollout guard, not a newly confirmed client preference.

**For the principal's content:** Alex agreed to appear in the discussed video (15:17–15:54). Do not infer permission to publish prospect identities, private messages or account screens, or blanket permission for future recordings and ad uses. Agree the specific material before release. Use the reported manual baseline as context and measure actual pilot time, acceptance and replies before making before/after claims. Publication remains a separate principal action.

## 14. Remaining inputs and decisions

The call confirms MacBook Air, Claude Code, non-Premium LinkedIn, recommendations-led discovery, approximate daily volume, both sequence delays and willingness to appear in the discussed video. The following remain open:

1. **In-app campaign setup:** Alex enters targeting criteria, geography/language, templates with variables, optional personalisation instructions and invitation-note preference when configuring each campaign. Prospect examples are optional. These values do not block development; valid targeting and templates are required to activate the relevant live campaign. The actual recommendation page/surface still needs inspection for the browser driver.
2. **Operating settings:** LinkedIn interface language, macOS version/chip, time zone, working hours, computer availability/keep-awake agreement, calendar versus working-day delays, whether manual message counts include follow-ups, approval preference and starting limits are entered through app controls. English app UI remains the principal’s requirement.
3. **Account and AI setup:** previous account warnings/search caps, other ongoing outreach, corrected risk understanding, Claude Code subscription suitability and API cost allowance. The call does not confirm these.
4. **Handover and evidence:** support/update arrangement, joint sample-review criteria, transcript’s conflicting call baseline, exact publication scope and permission for any additional recording. Automated website enrichment remains optional pending scope agreement.

Proceed with the engine and fixtures using labelled configurable defaults; let Alex supply campaign criteria, message templates, personalisation and timing/volume through the app before activating his live campaign. No delivery date or performance guarantee was agreed.

## 15. Risks

- **Account restriction.** LinkedIn prohibits automation. Pacing, a real Chrome profile, his home IP and low volume reduce the signals but cannot remove the risk. Earlier acceptance was reported by the principal; the call’s “no risk” reassurance must be corrected and understanding reconfirmed before Alex’s live run. Do not promise zero risk or free leads.
- **LinkedIn UI changes** will break selectors periodically. Mitigations: fixtures, fail-safe stop and `doctor`. Fixes need the principal; the support arrangement after "done" is undecided.
- **Laptop-only operation** means activity only while his computer is awake. Confirm Alex’s actual availability and keep-awake preference before treating background coverage as agreed.
- **Subscription use of AI CLIs** for automated jobs may be limited by provider terms; API keys are the fallback.

<!-- v1.1 source: Efforts/inbox/2026-11-11-alex-discovery-call.md; selected timestamped call excerpts. Original source: Efforts/inbox/2026-11-10-linkedin-outreach-automation-request.md (principal's design message, round 1 and round 2 answers; client screenshot). Limits marked (guess) are assistant defaults, not LinkedIn-published figures. -->


## 16. Additions and redactions since v1.0

### Additions

- Recommendations-led discovery alongside search, with shared budgets, fixtures, persistent cursors and discovery provenance (8:48).
- Local owner-operated business criteria, a flexible roughly-under-50 preference, industry evidence and generic-copy/review fallbacks; separate local-business and hotel audiences (4:06, 7:22–12:01).
- Confirmed MacBook Air, Claude Code and non-Premium LinkedIn; Mac-first onboarding while retaining the earlier cross-platform requirement (12:44, 17:58, 18:46).
- Reported 15–20 invitations and 10–15 messages/day, roughly 30–60 minutes per manual session and roughly 20% replies, all qualified as estimates (5:00, 13:36).
- Alex’s agreement to appear in the discussed video, with private-data and further-use boundaries (15:17–15:54).
- Lifetime contact suppression so campaign archiving cannot bypass the existing “never twice” requirement; this is an engineering correction, not an Alex request.

### Removed or replaced in the current specification

- Search-only discovery replaced with recommendations plus search.
- Five-working-day follow-up default replaced with a proposed 24–48 hours to reflect Alex’s actual cadence; day/window policy remains open.
- Thirty automated messages/day replaced with a proposed ten total/day starting budget, pending clarification of his message-count scope.
- “Assumed free account” and unknown OS/AI tool replaced with the call’s confirmations; neither subscription entitlement nor API spend is assumed.
- Generic personalisation alone replaced with reviewable evidence for industry-specific copy.
- No zero-risk or guaranteed-free-leads claim carried forward from the call. Earlier risk acceptance is qualified because of the later reassurance.
- No definitive call-conversion rate, strict 50-person cutoff, legal-form blacklist or blanket publication consent inferred from ambiguous statements.

These are specification redactions and replacements; historical source documents and the original PDF are retained. No personal details were removed from the source capture, and this PDF is a private technical handoff rather than a public case study.


## 17. Principal clarification on configurable app inputs

Added in v1.2 after review of v1.1:

- **Timing and volume:** Alex configures delays and account-wide budgets through app inputs. The call-informed numbers are editable defaults.
- **Message content:** Alex enters templates with variables and optional personalisation instructions in each campaign; exact copy is not a build prerequisite.
- **Targeting:** Alex enters qualification criteria per campaign. Example profiles are optional aids, not a required discovery deliverable.
- **Redaction:** removed the implication that another collection round for exact copy, example prospects or fixed limits is necessary before development. The app validates the relevant inputs before live activation.

Source: principal’s three annotated corrections in `Efforts/inbox/2026-11-11-alex-app-inputs-clarification.md`. Architecture, shared budget enforcement and stop rules remain as specified.
