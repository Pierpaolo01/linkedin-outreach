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
