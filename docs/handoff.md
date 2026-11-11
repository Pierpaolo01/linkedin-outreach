# Build handoff: LinkedIn outreach tool

For a fresh build session. Written 2026-11-11 from the principal's review of the build-readiness proposals. Read this file, then [spec v1.2](2026-11-11-linkedin-outreach-spec-v1.2.md). Where they differ, this handoff wins, because it records decisions the principal made after v1.2.

Sources: [build-readiness capture](../inbox/2026-11-11-linkedin-build-readiness-request.md) (the principal's verbatim comments), ADR-025 in `Atlas/decisions.md`.

## 1. Mission

Build the tool in spec v1.2 end to end: a local web app that runs LinkedIn outreach (invite, message after acceptance, one follow-up) through a dedicated Chrome window, with a dashboard, a SQLite database and an AI scoring step. You build and verify everything yourself. The principal reviews at five milestone gates and gives feedback there. Stop at each gate and wait.

Done for this handoff means milestone 5 has passed on the principal's laptop. Installing it for Alex is a later step the principal starts.

The build runs in its own repository and session (ADR-010). Do not edit the vault at `~/Documents/resultlabs`. Copy spec v1.2 and this handoff into the new repository under `docs/` so later sessions do not need the vault.

## 2. What the principal approved, verbatim

> I want Ai to fully build it out, with me as human in the loop to provide feedback on milestones
>
> I want the Ai to fully verify and test it's own work end to end.

On the repository: "Yes create new private repo". On testing: "No it can run against my real linkedin" and "Test live, who cares about consenting contacts". On safeguards and platforms: "Don't over engineer or over think, keep it simple".

This authorises, using the logins already on this laptop:

- a private GitHub repository `Pierpaolo01/linkedin-outreach`, checked out at `~/Documents/linkedin-outreach`;
- driving the principal's own LinkedIn account through the tool's dedicated Chrome profile, including real invitations and messages sent by the tool's campaign flow.

Nothing else external. No paid service, no new account, no access to Alex's LinkedIn or machine, no publication.

## 3. Changes to spec v1.2

| Topic | Spec v1.2 | Build this instead |
| --- | --- | --- |
| Test target | Fixtures first, live account late (slices 2–3 after the engine) | The principal's real LinkedIn from milestone 1. Driver and data-model decisions come from the real pages |
| Platforms | Mac, Windows and Linux, CI on three OSes, service installers for each | macOS only: setup, auto-start (launchd), keep-awake (`caffeinate`), CI on macOS. Keep paths and scripts portable where it costs nothing. This is the chief of staff's reading of "don't over engineer"; the principal did not say "Mac only" |
| Interface language | English and Italian, to confirm | Italian first, English also supported. Selectors keyed by the page's `lang` |
| Test contacts | 3–5 consenting contacts | None. Live tests are a real small campaign on the principal's account |
| Scoring check | Joint sample review with pass criteria | No labelled sample. The AI scores against the campaign's criteria; the principal looks at the approval queue at gate 3 |
| Replies after the follow-up | Not specified | Not tracked. The automation's job for a prospect ends when the follow-up is sent. The Stats screen labels reply rate as "replies seen before the follow-up" |
| Warm-up, weighted turns | Loosely defined | Your choice; take the simplest version. Plain round-robin is fine |
| Limit windows | "Rolling" in section 6, "resumes tomorrow 09:00" in the UI text | Calendar day and calendar week in the app's time zone (chief of staff's choice, to match the UI text) |
| AI backends | Four | Build the adapter with the `claude` CLI and the Anthropic API key first, since Alex uses Claude Code. Add `codex` CLI and OpenAI only if they are quick once the adapter exists |
| UI components | Tailwind + shadcn/ui | Tailwind + daisyUI, because this laptop's `daisyui` skill sets it as the UI library. The principal has not confirmed this swap; follow his answer if he gives one |

Everything else in spec v1.2 stands: architecture, data model, lifecycle, stop rules, safety stop, lifetime suppression, the campaign wizard and the screens.

## 4. Rules of engagement

- **Keep it simple.** One client, one install per user. No speculative abstraction, no feature the spec does not name. When two designs work, take the smaller one and note it in `docs/decisions.md`.
- **Decide small things yourself.** Record the decision and continue. Ask the principal only at a gate, or when something below needs him.
- **The principal types his LinkedIn login.** Never ask for, read or store his password. If LinkedIn shows a login wall, checkpoint, CAPTCHA or warning, stop all LinkedIn activity and tell him. Never try to get past it.
- **Real sends only through the app's campaign flow**, with the app's limits, after the principal has approved the prospects in the approval queue. No ad hoc scripts that invite or message people. Keep auto-approve off during the build.
- **Never write message copy that goes out under his name.** He enters targeting and templates for the test campaign in the app (gate 3).
- **Start low.** Use the spec's default limits or lower on his account. He may raise them.
- **Saved LinkedIn pages contain real people's data.** Commit fixtures only after replacing names, profile URLs and photos; otherwise keep them in a git-ignored folder.
- **Secrets and the Chrome profile stay in the data directory**, never in the repository, logs or reports.
- **Evidence over claims.** Each milestone ends with a report in `docs/milestones/M<n>.md`: what was built, the commands run with their output, screenshots, what was not verified and why. If a check failed or was skipped, say so.

## 5. How you verify your own work

1. **`npm run verify`** is the one command for everything that needs no LinkedIn: typecheck, lint, unit tests, the engine simulation, parsing tests on saved pages, and a browser test of the dashboard running on the fake driver. It runs in CI on every pull request.
2. **Engine simulation.** The engine runs against the fake driver in spec slice 1 with a controllable clock. Simulate a three-week campaign with the process killed at random points, and assert:
   - no step is sent twice for the same prospect;
   - no limit is exceeded in any day or week;
   - nothing is sent outside working hours;
   - nothing is sent after a reply or after the user has messaged the lead himself;
   - nobody is contacted in a second campaign;
   - after downtime the next day's activity is a normal day, not a backlog.
3. **`npm run live:check`** runs the read-only driver operations against the real account and checks that each returns well-formed data: session state, recommendations, people search, profile, recent connections, thread read. Run it yourself whenever the driver changes, and once with the LinkedIn interface in Italian and once in English.
4. **Live sends** are verified by the real campaign in milestone 4: for each invite, message, follow-up and withdrawal, compare the action ledger with what LinkedIn shows afterwards (sent invitations, the thread). Acceptances take real days, so this milestone stays open across days; the app keeps running and you check back.
5. **Independent review.** Before each gate, have a reviewer that did not write the code check the milestone against this handoff and the spec.

## 6. Milestones and gates

At each gate, stop, post the milestone report and wait for the principal's feedback. Apply it before moving on.

| # | Build | You verify | The principal at the gate |
| --- | --- | --- | --- |
| 1 | Repository, skeleton, `setup` / `start` / `doctor`, SQLite and migrations, the dedicated Chrome window, login and health detection, and the read-only driver: recommendations, search, profile, recent connections, thread read. Saved pages become fixtures | `verify` green; `live:check` green on his account in both languages; session survives an app restart | Logs in to LinkedIn once in the dedicated window at the start. At the gate: confirms which recommendations page to use and looks at a sample of parsed prospects |
| 2 | Engine on the fake driver: state machine, scheduler, limits, pacing, working hours, restart reconciliation, lifetime suppression | The simulation in section 5 passes, with the report showing each assertion | Reads the report |
| 3 | AI adapter, scoring, variable cleaning, optional personalisation; the full dashboard and campaign wizard; live discovery and scoring wired in. No sends yet | `verify` green including the dashboard browser test; a real discovery and scoring run on his account | Starts with two or three dashboard layout options as screenshots and picks one. At the gate: creates a real campaign in the UI with his own targeting and message templates, reviews the approval queue, gives UI feedback |
| 4 | Outreach actions: invite, acceptance detection, message, follow-up, withdraw, stop rules, limit and cap detection; auto-start, keep-awake, daily backups, `update` | The campaign from gate 3 runs at low volume on his account; ledger matches LinkedIn for every action; a reboot and a sleep in the middle lose nothing; a reply and a manual message each stop a sequence | Approves the first batch of prospects in the queue so sending can start. At the gate: reads the activity log and the report |
| 5 | Pilot: the campaign keeps running for one to two weeks; fix what it finds; write the AGENTS.md runbook for Alex's AI | No safety stop caused by a bug; a clean clone in an empty folder set up by a fresh agent from AGENTS.md alone reaches a green `doctor` | Decides whether it is ready for Alex |

Milestone 1 comes first on purpose: the real recommendations page, the acceptance signal and the thread layout decide parts of the data model and the engine.

Within a milestone, ship each slice as its own pull request and merge it once its checks and review are clean. This is the chief of staff's default so the build is not stuck on stacked branches; the principal's standing rule allows agents to merge their own pull requests in `Pierpaolo01/*` under `full-send` or when asked, so confirm it with him at gate 1 if he has not said.

## 7. Skills to invoke

Load each with the Skill tool when its moment comes.

| Skill | When |
| --- | --- |
| `tdd` | Every slice of the engine, driver parsing and API: write the failing test first |
| `typescript-best-practices` | Before reading or editing any `.ts` / `.tsx` file |
| `trw-design-patterns` | Shaping the prospect state machine, the driver and AI adapters, and deciding against extra layers |
| `codebase-design` | Drawing the seams: UI ↔ database ↔ worker ↔ driver |
| `domain-modeling` | Once, at the start, to fix the terms: person, prospect, campaign, action, job, safety stop |
| `playwriter` | Inspecting live LinkedIn pages while writing selectors and choosing the recommendations surface |
| `claude-api` | Before writing the AI adapter (headless `claude` CLI and the Anthropic API) |
| `prototype`, `frontend-design:frontend-design`, `daisyui` | Dashboard: layout options first, then the build |
| `vercel-react-best-practices` | While writing the React dashboard |
| `run` | Launching the app to see a change working, and for dashboard screenshots |
| `diagnosing-bugs` | Any failure that is not obvious on first read |
| `writing-for-agents` | The AGENTS.md runbook that Alex's AI will follow |
| `ship-pr` | Every pull request, through review and CI |
| `code-review` | Before each gate, on the milestone's changes |
| `council` | The independent review before gates 2 and 4, where a missed bug sends wrong messages to real people |
| `security-review` | Once before gate 5: local server binding, secrets file, data directory |

## 8. Laptop facts observed 2026-11-11

| Item | Fact |
| --- | --- |
| Machine | macOS 26.6.2, Apple silicon (arm64) |
| Node | v22.23.2 on PATH; pnpm 10.1.0 also present. The spec's commands use npm; either is fine, pick one |
| GitHub | `gh` logged in as `Pierpaolo01`. `Pierpaolo01/linkedin-outreach` does not exist yet; `~/Documents/linkedin-outreach` does not exist |
| Google Chrome | Not found at `/Applications/Google Chrome.app`. The spec prefers installed Chrome with Playwright's Chromium as fallback. Installing Chrome is a setup step the spec already expects; do it through `setup` and say so in the M1 report |
| AI CLIs | `claude` and `codex` both on PATH |
| Disk | 8.2 GB free on `/`. Check `df -h /` before installing browsers; ask before clearing any cache |

## 9. Open items that do not block the build

- Whether the principal's LinkedIn interface is in English or Italian. `live:check` needs one run in each; switching the language is an account setting, so ask him to switch it or to say you may.
- Alex's access to the private repository (GitHub account and an invitation) is the principal's step before onboarding.
- Subscription terms for running the `claude` CLI on a schedule: check the provider's current terms before gate 3 and report what you find; the API key is the fallback.
- Reconfirming account risk with Alex, the support arrangement after hand-over and what may be published all stay with the principal (spec sections 13–15).
- Time estimates in spec section 13 were for one developer and the old slice order. They are not commitments.

<!-- src: Efforts/inbox/2026-11-11-linkedin-build-readiness-request.md; Efforts/reports/2026-11-11-linkedin-outreach-spec-v1.2.md; Atlas/decisions.md ADR-025; laptop checks run 2026-11-11 in the chief-of-staff session. -->
