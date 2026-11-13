# Product

<!-- impeccable:product-schema 1 -->

Source note: this record was written without an interview, on the principal's instruction. Every fact comes from `docs/handoff.md`, `docs/spec-v1.2.md`, `CONTEXT.md`, `docs/decisions.md` or the dashboard as built. Statements marked **(inferred)** are not stated in those documents and need the principal's confirmation.

## Platform

web

## Users

One user per install: the owner of the LinkedIn account the app drives. The first user is a non-technical business owner who runs an agency for local business owners and a second business for hotels, and who until now did this outreach by hand in sessions of roughly 30 to 60 minutes a day (his own estimate, spec section 1).

He does not install or maintain the app himself. He asks his AI coding tool to set it up, start it, update it and troubleshoot it (spec sections 2 and 11). The dashboard is the only part of the product he works in directly.

His jobs in the dashboard:

- approve or reject the prospects the app found and scored, after reading why each was picked and what they would receive;
- create a campaign and pause or resume it;
- see what the app did on his account and how much of each daily budget is used;
- deal with what the app will not decide by itself: prospects held for review, and a safety stop.

**(inferred)** He checks in briefly rather than working in the dashboard for long, mostly on a laptop and sometimes at phone width. The documents say the app replaces his manual sessions and that the dashboard is tested at 390 px wide; they do not describe how often or how long he looks at it.

## Product Purpose

A local web app that runs one user's LinkedIn outreach for him, reproducing his manual process: send a connection invite, send a short message one to two days after it is accepted, and send one follow-up if there is no reply. It finds prospects from LinkedIn recommendations or a people search, scores them with an AI against the campaign's scoring brief, and waits for the user's approval before any outreach (unless he turns on auto-approve for a campaign).

Success, as the spec defines it: the user has it set up on his Mac and campaigns are running, with no safety stop caused by a bug. The documents set no performance target and forbid projecting calls, revenue or time saved from the user's recollected numbers.

## Positioning

- It runs on the user's own Mac, through a visible Chrome window the app owns, logged in to his own account. No third-party connector and no hosted service.
- The user approves prospects and reads the exact texts before anything is sent. The AI scores and cleans variables; it never decides whether to send.
- It works at a person's pace: shared daily and weekly budgets, a working window, random gaps and breaks, and no catching up after downtime.
- A person who has been contacted once is never contacted again in any campaign.
- When LinkedIn shows a login wall, checkpoint, CAPTCHA, warning or its own invitation limit, the app stops all LinkedIn activity and waits for the user. It never tries to get past one.

Not in scope (spec section 1): multi-user or hosted use, a reply inbox or reply notifications, Sales Navigator, InMail, CRM integrations.

## Operating Context

- The server binds to `127.0.0.1` only (port 4747 by default) and has no login screen. The user opens the dashboard in a browser tab on the same Mac.
- The app starts at login, keeps the Mac awake while a campaign is working inside the working window, and resumes from its database after sleep, restart or a crash.
- The dedicated window is a separate Chrome window. The user logs in to LinkedIn there once and otherwise leaves it alone. The dashboard never touches LinkedIn; it reads and writes the local database.
- The app acts on LinkedIn only inside the working window (default Monday to Friday, 09:00 to 18:00, Europe/Rome). Outside it, the dashboard still works.
- Replies arrive in the user's own LinkedIn app, not in the dashboard. The app's work for a prospect ends when the follow-up is sent.
- What the user does by hand on LinkedIn counts toward LinkedIn's view of the account and the app cannot count it. Settings says so.
- Open tension: with the server bound to `127.0.0.1`, a phone cannot reach the dashboard. The layout is built and tested at phone width, but no document says how a phone would connect. Treat phone width as a supported layout, not a confirmed way of using the product.

## Capabilities and Constraints

Screens (spec section 10, all built): Home, Campaigns, Campaign detail, the campaign wizard, Approval queue, Needs review, Activity log, Stats, Settings.

- **Home** leads with what needs the user (approvals, needs review, a safety stop), then campaigns, today's usage against each budget, and what the app did.
- **Approval queue** shows each prospect's score, the reason, the evidence for industry and size, and the texts they will receive. Approve or reject one, approve all shown, filter by score and campaign. A and R keys approve and reject the selected row (decision 65).
- **Campaign wizard**: name, targeting, scoring brief, approval settings, messages with a live preview, timings.
- **Settings**: the dedicated window, working window, budgets, warm-up and pace, keep-awake, AI provider, backups, start at login, CSV export.
- **Safety stop**: a banner on every page that says what LinkedIn showed and what to do, with Resume behind a confirmation. Only the user can lift it.

Constraints:

- A spent budget is not a problem state. That kind of work waits and resumes by itself ("Budget spent; it resets tomorrow 09:00"). A safety stop is the only state that needs the user to act before work continues. The two must never look alike.
- A pause is the user's choice on one campaign. A safety stop halts everything. They are different words and different things.
- The interface is in English (spec sections 2 and 10). The user's LinkedIn interface may be in Italian; that affects the driver, not the dashboard.
- People's names, companies and message texts in the dashboard are real people's data. Screenshots for docs and reviews use the test data only.
- macOS only for this build. Tailwind and daisyUI (decisions 3 and 22). Sidebar layout (decision 65).
- Vocabulary is fixed by `CONTEXT.md` and applies to UI copy: person, prospect, campaign, discovery, scoring brief, approval queue, sequence, step, stage, needs review, suppression, action, budget, safety stop, working window, dedicated window. Never "lead", "contact", "target", "scraping", "blacklist", "quota" or "bot".

Undecided (spec sections 14 and 15): whether delays count calendar or working days, the user's own starting limits, the support arrangement after hand-over, and what may be published.

## Brand Commitments

No brand has been defined. The sidebar currently titles the app "Outreach"; no document confirms a product name, logo or identity, and none should be invented.

Voice, as the existing UI copy and `CONTEXT.md` establish it: plain English sentences that say what the app did or will do and what the user should do next ("Sent an invite to …", "Nothing runs on LinkedIn until you resume."). No sales language, no claims about results, and no promise that the account is safe (spec section 15).

## Evidence on Hand

- Screenshots of every screen as built, desktop and phone width: `docs/milestones/img/before/`.
- The three layout options shown at gate 3 and the reasons for the choice: `docs/milestones/img/m3-layout-*.png`, `prototypes/dashboard-layouts/`, decision 65.
- Milestone reports with real runs: `docs/milestones/M1.md` to `M4.md`.
- Test data ("Test Person 1", "Hotel owners, Rome") served by the fake driver for the dashboard browser test: `e2e/`.

Absent, and not to be fabricated: testimonials, customer names, measured acceptance or reply rates, time-saved figures, pricing. The spec's volume and reply numbers are the first user's recollections, not analytics.

## Product Principles

1. **The user stays in charge of his own name.** The app acts on a real account under his name, so every screen shows what was done, what will be sent and why, before asking him to trust it.
2. **Calm is the normal state.** Waiting, a spent budget and work outside the working window are routine and are reported as routine. Nothing about them asks for attention.
3. **A safety stop cannot be missed.** It is the one alarm in the product. It appears on every page, says what LinkedIn showed and what to do, and nothing else competes with it.
4. **What needs the user comes first.** He is there to decide a few things and leave; approvals, held prospects and a stop come before any report.
5. **Plain and honest.** The product is a careful assistant for one person's outreach. It never presents itself as a volume or growth tool, and never claims more than it has observed.

## Accessibility & Inclusion

No standard has been set in the project documents. What exists and must be kept: the approval queue works from the keyboard (A, R, arrow keys), the safety stop is announced as an alert, and no page scrolls sideways at 390 px wide (`e2e/dashboard.spec.ts`). **(inferred)** The first user is not technical, so no screen may depend on knowing terms outside `CONTEXT.md`'s vocabulary; the Settings text for restoring a backup and installing auto-start, which shows Terminal commands, is meant for his AI coding tool.
