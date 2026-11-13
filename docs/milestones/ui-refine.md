# UI refinement (feat/ui-refine)

2026-11-13. A finish pass on the dashboard (`src/ui/`), on the branch `feat/ui-refine`.

The run kept the existing look (green-grey palette, Seravek, the sidebar and drawer, flat surfaces) and made it consistent, readable and usable at 390px. The direction and every item are in `docs/ui-refine-backlog.md`. It started from a critique (C-01 to C-25) and an audit (A-01 to A-30). They became 48 backlog items, worked through in eight phases (extract, colorize, layout, adapt, harden, clarify, animate, polish), then two finish reviews and six council rounds. All 48 items are fixed and 12 are deferred, each with a reason. No route, behaviour or data shape changed. Everything below comes from the seeded demo apps that Playwright starts on the fake driver; LinkedIn was not touched.

## Before and after

"Before" is the baseline set from `main`, taken on 12 November (commit `83ea9d6`). "After" is this branch at `485aaf2`. Desktop shots are 1440 wide at 1x. Phone shots are 390 wide at 2x. Both are full-page.

| Page | Viewport | Before | After |
| --- | --- | --- | --- |
| Home | Desktop 1440 | ![](img/before/home-desktop.png) | ![](img/after/home-desktop.png) |
| Home | Phone 390 | ![](img/before/home-phone.png) | ![](img/after/home-phone.png) |
| Home during a safety stop | Desktop 1440 | ![](img/before/home-safety-stop-desktop.png) | ![](img/after/home-safety-stop-desktop.png) |
| Home during a safety stop | Phone 390 | ![](img/before/home-safety-stop-phone.png) | ![](img/after/home-safety-stop-phone.png) |
| Approval queue | Desktop 1440 | ![](img/before/approvals-desktop.png) | ![](img/after/approvals-desktop.png) |
| Approval queue | Phone 390 | ![](img/before/approvals-phone.png) | ![](img/after/approvals-phone.png) |
| Needs review | Desktop 1440 | ![](img/before/needs-review-desktop.png) | ![](img/after/needs-review-desktop.png) |
| Needs review | Phone 390 | ![](img/before/needs-review-phone.png) | ![](img/after/needs-review-phone.png) |
| Campaigns | Desktop 1440 | ![](img/before/campaigns-desktop.png) | ![](img/after/campaigns-desktop.png) |
| Campaigns | Phone 390 | ![](img/before/campaigns-phone.png) | ![](img/after/campaigns-phone.png) |
| A campaign's page, one person open | Desktop 1440 | ![](img/before/campaign-detail-desktop.png) | ![](img/after/campaign-detail-desktop.png) |
| A campaign's page, one person open | Phone 390 | ![](img/before/campaign-detail-phone.png) | ![](img/after/campaign-detail-phone.png) |
| Activity log | Desktop 1440 | ![](img/before/activity-desktop.png) | ![](img/after/activity-desktop.png) |
| Activity log | Phone 390 | ![](img/before/activity-phone.png) | ![](img/after/activity-phone.png) |
| Stats | Desktop 1440 | ![](img/before/stats-desktop.png) | ![](img/after/stats-desktop.png) |
| Stats | Phone 390 | ![](img/before/stats-phone.png) | ![](img/after/stats-phone.png) |
| Settings | Desktop 1440 | ![](img/before/settings-desktop.png) | ![](img/after/settings-desktop.png) |
| Settings | Phone 390 | ![](img/before/settings-phone.png) | ![](img/after/settings-phone.png) |
| Wizard, Who fits | Desktop 1440 | ![](img/before/wizard-who-fits-desktop.png) | ![](img/after/wizard-who-fits-desktop.png) |
| Wizard, Who fits | Phone 390 | ![](img/before/wizard-who-fits-phone.png) | ![](img/after/wizard-who-fits-phone.png) |
| Wizard, Messages | Desktop 1440 | ![](img/before/wizard-messages-desktop.png) | ![](img/after/wizard-messages-desktop.png) |
| Wizard, Messages | Phone 390 | ![](img/before/wizard-messages-phone.png) | ![](img/after/wizard-messages-phone.png) |

`img/after/overflow.json` records how far each page scrolls sideways. It is 0 for all 22 shots, as it was for the before set.

## Walkthrough videos

- [Desktop, 1440 by 900, 60 seconds](img/after/ui-refine-walkthrough.mp4) (`img/after/ui-refine-walkthrough.mp4`). Home (Today's usage and What the app did), the approval queue (Test Person 2 approved with the A key, so the row folds and the header reads "7 waiting, 1 decided"; one follow-up opened), Campaigns, Hotel owners, Rome with one person open, a new campaign through Name, Where people come from, Who fits, Approval and Messages (the preview fills in "Anna" and "Example Srl"), then Review and start, and the activity log switched to "Warnings and errors" and back. The draft campaign was not started.
- [Phone, 390 by 844, 26 seconds](img/after/ui-refine-walkthrough-phone.mp4) (`img/after/ui-refine-walkthrough-phone.mp4`). Home, the menu, the approval queue, then Hotel owners, Rome from the menu with one person open.

Both were recorded with Playwright's `recordVideo` against a fresh seeded demo app (port 4748), from a throwaway script outside the repository. A red circle is drawn where the pointer is, because the recording does not show one. The phone video is recorded at 390 by 844 CSS pixels, so it is less sharp than the 2x phone screenshots. Both files are H.264 with `-pix_fmt yuv420p -movflags +faststart`.

## Commands run

```
$ npm run build:ui
vite v8.3.8 building client environment for production...
✓ 141 modules transformed.
dist/ui/index.html                   0.58 kB │ gzip:   0.37 kB
dist/ui/assets/index-DdWuBi9M.css  135.95 kB │ gzip:  21.40 kB
dist/ui/assets/index-DC5QS5Gw.js   489.96 kB │ gzip: 142.75 kB
✓ built in 253ms
```

The build also prints two warnings from the CSS optimiser about an empty selector in daisyUI's `.join` and `.btn:hover` rules. Both are in daisyUI 5.7.50's own rules. The build still succeeds.

```
$ SCREENSHOTS=1 SHOT_DIR=after npx playwright test e2e/screenshots.spec.ts
Running 3 tests using 1 worker
  ✓  1 e2e/screenshots.spec.ts:74:3 › desktop › milestone 3 screenshots (4.7s)
  ✓  2 e2e/screenshots.spec.ts:92:3 › desktop, the remaining screens › milestone 3 screenshots of campaigns, detail, activity, stats, settings and the wizard (9.1s)
  -  3 e2e/screenshots.spec.ts:142:3 › phone › milestone 3 phone screenshot
  1 skipped
  2 passed (28.4s)
```

The skipped test writes the single milestone 3 phone shot. With `SHOT_DIR` set, every page is already shot on the phone, so it skips itself.

```
$ npm run verify
> npm run typecheck && npm run lint && npm run test && npm run build:ui && npm run test:e2e
(typecheck and lint: no output)
 Test Files  81 passed (81)
      Tests  1966 passed (1966)
   Duration  32.71s (tests 86%, import 13%, transform 1%)
✓ built in 351ms
  3 skipped
  67 passed (1.5m)
```

`verify` passed on the first run. The three skipped browser tests are the screenshot spec's, which run only with `SCREENSHOTS=1`.

## What was not verified

- Real touch devices and Safari. Every capture is desktop Chrome through Playwright; the phone shots and video are Chrome at 390 wide, not a phone.
- The screenshot dialog in Settings shows the seed's grey placeholder image, not a real screenshot.
- Log times, "Last checked" and the dates beside budgets are stamped when the seed runs, so they differ between the before and after sets. For example, the spent discovery budget reads "resumes tomorrow 09:00" in the before set (taken on a Thursday evening) and "it resets Monday 09:00" in the after set (taken early on Friday).
- The live app, the real data directory and LinkedIn were not opened.
