# Decisions

Small decisions made during the build, newest last. The handoff (`docs/handoff.md`) wins over the spec (`docs/spec-v1.2.md`); this file records what neither settles.

| # | Date | Decision | Why |
| --- | --- | --- | --- |
| 1 | 2026-11-11 | npm, not pnpm | The spec's commands are written for npm and Alex's AI will type them |
| 2 | 2026-11-11 | Default branch `main` | Convention |
| 3 | 2026-11-11 | Tailwind + daisyUI, not shadcn/ui | Handoff section 3. Unconfirmed by the principal; ask at gate 1 |
| 4 | 2026-11-11 | Browser tests of the dashboard use installed Chrome (`channel: "chrome"`), not a downloaded Chromium | GitHub's macOS runners ship Chrome, and the laptop has 8 GB free. Playwright's Chromium stays the fallback when Chrome is missing |
| 5 | 2026-11-11 | Chrome is installed by `npm run setup` with `brew install --cask google-chrome` when missing | Handoff section 8: install through setup |
| 6 | 2026-11-11 | Live pages are saved to `captures/` in the repo (git-ignored) and scrubbed into `fixtures/` before commit | Handoff section 4. Keeps real people's data out of git |
| 7 | 2026-11-11 | Domain terms live in `CONTEXT.md` | One vocabulary for code, UI and reports |
| 8 | 2026-11-11 | Selectors live per page in `src/linkedin/parse/selectors.*.ts`, plus `src/linkedin/selectors.ts` for the session | One file for every page would be edited by every parser slice at once |
| 9 | 2026-11-11 | Enumerations (stage, action type, job state) are TypeScript constants, not SQL CHECK constraints | Adding a value then needs no migration |
| 10 | 2026-11-11 | `session_state` is a single row (id 1) | One account, one dedicated window per install |
| 11 | 2026-11-11 | Page classification order: restriction wording, checkpoint URL, security-check wording, login wall, signed-in navigation, CAPTCHA markers, logged-out home, unknown | The login page and the signed-in messaging page both embed an invisible reCAPTCHA; both were first misread as checkpoints |
| 12 | 2026-11-11 | Saved pages are parsed with `node-html-parser`, not in the browser | Parsers are pure functions of the HTML, so fixtures test exactly what runs live |
| 13 | 2026-11-11 | Hand-written fixtures are named `synthetic-*` and are exempt from the leak guard's id rules | Their ids are invented; real captures keep the full guard |
| 14 | 2026-11-11 | The thread parser decides a sender from the profile link and the shown name, and throws when they disagree | A wrong sender would stop or continue a sequence wrongly; unreadable is safer than guessed |
| 15 | 2026-11-11 | No parser depends on `data-view-name` alone | LinkedIn writes it only into the first page a browser session loads; later loads have none (seen live) |
| 16 | 2026-11-11 | A conversation is opened by URL, `/messaging/compose/?recipient=<member id>`; the member id comes from Message links and is returned by `viewProfile` and `listRecentConnections` | No click and no second parser. Milestone 2 stores the member id on the person. See `docs/research/thread-navigation.md` |
| 17 | 2026-11-11 | `readThread` is for 1st-degree connections only | For anyone else the compose URL opens a new InMail form, which the parser refuses |
| 18 | 2026-11-11 | The driver latches on a login wall, checkpoint or restriction: every later call rethrows the same error without loading a page | A safety stop must not depend on every caller remembering to stop |
| 19 | 2026-11-11 | `live:check` prints counts only; full results go to `<data dir>/live-check/` | Real people's data stays out of terminals, logs and reports |
| 20 | 2026-11-11 | No review bot is installed on the repository. Each pull request is reviewed by the lead session and CI; `code-review` runs before each gate, `council` before gates 2 and 4 | The principal's brief. Pullfrog can be added if he asks |
| 21 | 2026-11-11 | Workers share one checkout and get disjoint files; the lead splits their work into pull requests | Per-agent worktrees were not available to this session |
