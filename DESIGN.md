---
name: LinkedIn outreach dashboard
description: The local dashboard where one user approves prospects, runs campaigns and sees what the app did on his LinkedIn account.
colors:
  primary: "#2c5e4f"
  primary-content: "#ffffff"
  accent: "#e5ad42"
  accent-content: "#2b1d03"
  warning: "#e5ad42"
  warning-content: "#2b1d03"
  warning-strong: "#a8700f"
  error: "#b3352b"
  error-content: "#ffffff"
  success: "#2f7a4e"
  success-content: "#ffffff"
  info: "#33698f"
  info-content: "#ffffff"
  neutral: "#26302b"
  neutral-content: "#f2f4f0"
  base-100: "#f7f8f5"
  base-200: "#edefea"
  base-300: "#dce0d8"
  base-content: "#1d2521"
  muted: "#5b625d"
  control: "#818683"
  score-high: "#d5e8dc"
  score-mid: "#dce0d8"
  score-low-edge: "#dce0d8"
typography:
  display:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
  headline:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.556
  figure:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.333
    fontFeature: "tnum, lnum"
  body:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.429
  nav:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
  caption:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.385
  label:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.333
    fontFeature: "tnum, lnum"
  button:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
rounded:
  field: "0.375rem"
  box: "0.5rem"
  selector: "1rem"
  full: "9999px"
spacing:
  group: "0.75rem"
  card: "1.25rem"
  block: "1.5rem"
  section: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
    padding: "0 12px"
  button-secondary-hover:
    backgroundColor: "{colors.base-200}"
  button-halted-pause:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
  button-quiet:
    textColor: "{colors.muted}"
    rounded: "{rounded.field}"
  button-selected:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.neutral-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
  button-on-red:
    backgroundColor: "{colors.error-content}"
    textColor: "{colors.error}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.error-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
  nav-item:
    textColor: "{colors.base-content}"
    typography: "{typography.nav}"
    rounded: "{rounded.field}"
  nav-item-active:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.neutral-content}"
    typography: "{typography.nav}"
    rounded: "{rounded.field}"
  count-badge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-content}"
    typography: "{typography.label}"
    rounded: "{rounded.selector}"
  count-tile:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-content}"
    rounded: "{rounded.box}"
    height: "2.75rem"
  score-chip-high:
    backgroundColor: "{colors.score-high}"
    textColor: "{colors.primary}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  score-chip-mid:
    backgroundColor: "{colors.score-mid}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  score-chip-low:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  card:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.box}"
    padding: "20px"
  toolbar:
    backgroundColor: "{colors.base-200}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.box}"
    padding: "12px"
  input:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.field}"
  notice-waits:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  notice-note:
    backgroundColor: "{colors.base-200}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  action-error:
    backgroundColor: "{colors.error}"
    textColor: "{colors.error}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  safety-stop-banner:
    backgroundColor: "{colors.error}"
    textColor: "{colors.error-content}"
    typography: "{typography.body}"
    padding: "16px 40px"
  sidebar:
    backgroundColor: "{colors.base-200}"
    textColor: "{colors.base-content}"
    width: "16rem"
  wizard-step-current:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.neutral-content}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
---

# Design System: LinkedIn outreach dashboard

This file records the dashboard as built on branch `feat/ui-refine` after the refinement and council review round 6 (the commit after `bc77911` that also adds this file). Every value comes from `src/ui/index.css`, the shared parts (`src/ui/formParts.tsx`, `src/ui/icons.tsx`, `src/ui/ConfirmDialog.tsx`), the shell (`src/ui/shell/`), the pages (`src/ui/pages/`) and the words (`src/ui/words.ts`, `src/ui/format.ts`). It describes; it does not propose. Contrast ratios are the ones stated in the comments of `index.css` unless a line says "measured here".

## Overview

**Creative North Star: "The Quiet Desk"**

The dashboard is a light, flat, single-theme workspace: a quiet green-grey desk. A sage sidebar sits on the left, the page is warm off-white paper, and almost everything on it is dark ink text, hairline borders and numbers. Colour is spent on meaning, and each colour has one meaning: green for the main action and for work that is running, amber for what waits for the user, red for the safety stop and for an error.

The density is that of a working tool. Tables and lists carry real sentences ("Prospects waiting for your approval", "Budget spent; it resets Monday 09:00") in place of labels and icons. Text has two tones only, Ink and one solid muted tone. There are seven line icons in the whole product, no illustrations, no imagery and no logo. There is one typeface in three weights. The user reads, decides and leaves.

There is no dark theme (`prefersdark: false`, `color-scheme: light`). Motion is for state changes only: nothing moves on page load or for decoration.

**Key Characteristics:**
- One light theme: off-white page, sage sidebar, hairline borders, no shadows.
- One sans family (Seravek, the macOS system humanist sans) in weights 400, 500 and 600.
- Two text tones: Ink and a solid muted tone, never an opacity of Ink.
- One meaning per colour: green runs and acts, amber waits for the user, blue finds, red is the safety stop or an error.
- Every status is a mark plus words; a campaign that is not working is a ring, so marks differ by shape as well as hue.
- Numbers are tabular everywhere a count, time or score appears; a date or a count with its unit never breaks across lines.
- Two layouts from one build: a docked sidebar from 1024px, a modal drawer below it, where every control is a 44px target; a table is a table only while its own box has room for its columns.

## Colors

A green-grey neutral family with one deep green for action, one amber for waiting and one red for the safety stop and errors.

### Primary
- **Desk Green** (`primary`, #2c5e4f, white text on top): the main action on a screen ("Open queue", "Approve all 8 shown", "Save and continue", "Start the campaign", "Save settings"), the edge (at 50%) and words of the Approve button, the fill of a budget meter that still has room, a switch that is on, a selected radio, the edge of the chosen discovery source, the check of a finished wizard step, the number on a high score chip, and short success sentences ("Saved.").

### Secondary
- **Waiting Amber** (`accent` and `warning`, #e5ad42, with `accent-content` #2b1d03 on top; the two tokens are the same hex): what waits for the user. As a fill: the count tiles on Home, the count badges in the sidebar, and the bar shown when the app does not answer. At 20% it is the fill of a "waits" notice ("Held for review: …", "Why: …").
- **Amber Dot** (`--color-warning-strong`, #a8700f): amber as a dot. The theme's amber is 1.9:1 on the page, so every `status-warning` dot uses this darker amber, which reads as a shape (3:1 and over; 3.95:1 on Desk Paper and 3.63:1 on Sidebar Sage, measured here). It marks a campaign "Waiting for approval", and a prospect at the stage "waiting for approval" or "needs review" in a campaign's People table.

### Tertiary
- **Stop Red** (`error`, #b3352b, white text on top). It has five places and no others:
  1. the safety stop: the full-width banner, the sidebar session card during a stop, and the filled red dot of a campaign "Stopped by safety stop";
  2. "LinkedIn needs you": the same banner with Re-check, and the session light whenever that banner shows ("Logged out", "Checkpoint", "Restricted", and "Unknown" after a check that could not tell);
  3. an error line in the activity log: red words and a filled red dot;
  4. a destructive confirm: the red confirm button (Archive, Start with auto-approve on);
  5. field errors and failed actions: a red edge on the control, red words under it, red words on a 10% red tint for a failed action, a red edge at 40% on a 5% tint for a failed load, the "Do not contact" badge (red words on red at 10%), the invite note's count past 300, and a wizard step with a problem (its number inside a 2px red edge).
- **The filled red dot** appears only in these places: a campaign's status line "Stopped by safety stop" (Home, Campaigns, Stats, the campaign's page) and its dot in the sidebar; the phone top bar's "Safety stop"; the session light whenever the red "LinkedIn needs you" banner shows, at "Logged out", "Checkpoint", "Restricted" or "Unknown" (the sidebar session card outside a stop, the phone top bar, the dedicated window's line in Settings); and the mark of an error line in the activity log and in Home's "What the app did". A form error never takes it.
- **Running Green** (`success`, #2f7a4e): the dot of a running campaign and of a logged-in session. Dots only.
- **Finding Blue** (`info`, #33698f): the dot of a campaign that is finding people. Dots only.

### Neutral
- **Desk Paper** (`base-100`, #f7f8f5): the page, cards, fields, the secondary button, the track of a spent meter, the low score chip.
- **Sidebar Sage** (`base-200`, #edefea): the sidebar, toolbars, the usage panel, the variables panel, a "note" notice, code blocks, skeletons, the hover of a secondary button, and (at 60%) an opened person's row and an approval row that holds the focus.
- **Hairline Sage** (`base-300`, #dce0d8): every border and divider, the track of a meter with room, the idle wizard step circle, the rule beside a quoted text, and the mid score chip.
- **Ink** (`base-content`, #1d2521): text. 14.71:1 on Desk Paper. Lead paragraphs are Ink, not a lighter tone.
- **Muted** (`--color-muted`, #5b625d): the one secondary text tone: hints, captions, table headers, times, a closed stage, placeholders. It is a solid colour, not an opacity, so it measures the same everywhere: 5.88:1 on Desk Paper, 5.41:1 on Sidebar Sage, 5.60:1 on an open row's tint, 4.69:1 on Hairline Sage.
- **Control** (`--color-control`, #818683): the edge of a field, select or textarea at rest, an unchecked radio or switch, the edge of every budget meter, and the fill of a spent meter. 3:1 on Desk Paper, Sidebar Sage and the row tint (3.2:1 on the usage panel).
- **Dark Moss** (`neutral`, #26302b, with `neutral-content` #f2f4f0): the selected state: the current sidebar item, the current wizard step, the chosen segment of a filter, a working day that is on. As a mark it is the ring of something that is not working and needs nothing from the user: a campaign that is a draft, paused, finished or archived, and a session that is "Not checked yet" or at "Search limit reached". On the current sidebar item every dot is light ink, since no status hue reaches 3:1 there.
- **Score Mint** (`score-high`, #d5e8dc) with a Desk Green number (5.82:1): a score of 7 or more. Also the "Nothing needs you" tile, a finished wizard step's circle, a passed AI test (at 60%), the chosen discovery source (at 40%) and selected text.
- **Score Sage** (`score-mid`, #dce0d8, the Hairline Sage value) with an Ink number (11.72:1): a score from 5 to under 7.
- **Score outline** (`score-low-edge`, #dce0d8): below 5, or not scored, the chip is Desk Paper inside a 1px inset Hairline Sage edge with an Ink number (14.71:1).

### Status map
| Meaning | Colour | Form |
|---|---|---|
| Campaign running; session logged in | Running Green | filled dot + words |
| Campaign finding people | Finding Blue | filled dot + words |
| Campaign waiting for approval; prospect waiting for approval or needing review | Amber Dot | filled dot + words |
| Campaign draft, paused, finished, archived; session not checked yet or at its search limit | Dark Moss | ring (1.5px, hollow) + words |
| Campaign stopped by a safety stop; session logged out, at a checkpoint, restricted or unknown (every state that raises "LinkedIn needs you") | Stop Red | filled dot + words |
| Activity line: warning | Ink | outlined triangle with "!" + "Warning:" |
| Activity line: error | Stop Red | filled dot + red words led by "Error:" |
| Budget with room | Desk Green on a Hairline Sage track, Control edge | meter |
| Budget spent | Control on a Desk Paper track, Control edge | full meter + muted "Budget spent; it resets …" |
| Score 7 to 10 / 5 to under 7 / under 5 or not scored | Score Mint / Score Sage / Desk Paper with a Hairline Sage edge | square chip with the number |
| Waits for the user (counts) | Waiting Amber | count tile, count badge |
| Safety stop; LinkedIn needs you | Stop Red | full-width banner; red session card during a stop |

### Named Rules
**The One Alarm Rule.** A solid Stop Red bar or panel means LinkedIn needs the user: the safety-stop banner, the "LinkedIn needs you" banner, and the session card during a stop. The only other solid red is the confirm button of a destructive question. A spent budget is a control-tone meter, a pause is a Dark Moss ring, and an error anywhere else is red words, so none can be taken for a stop.

**The Amber Waits Rule.** Amber marks what waits for the user: a count to approve or review, a campaign or prospect waiting for approval, a person held for review, an app that does not answer. A logged-out session is not amber: it raises the red "LinkedIn needs you" banner, and its light is the banner's red. A spent budget is not amber: it is not a problem and waits on nobody. A past log line is not amber: it no longer waits. A score is never amber. Amber is never the colour of a button.

**The Mark And Words Rule.** A status mark always sits beside its words ("Running", "Paused", "Stopped by safety stop", "Warning:"). No status is shown by colour alone, and a state that is not working differs by shape (a ring), not only by hue. A mark agrees with the banner above it: the session light is red whenever the red "LinkedIn needs you" bar shows.

**The Two Tones Rule.** Text is Ink or Muted. No text is an opacity of Ink. The only translucent text is white at 90% on Stop Red (5.21:1, measured here), for the secondary lines of the banner and the red session card.

## Typography

**Display Font:** Seravek (with Avenir Next, system-ui, sans-serif)
**Body Font:** the same family
**Label/Mono Font:** the browser's monospace stack, only for Terminal commands in Settings

**Character:** One humanist sans does everything. It is a font already on the user's Mac, so nothing loads from elsewhere. Hierarchy comes from size and from three weights, with kerning on, antialiased rendering, and underlines set 0.2em below the baseline so they clear the descenders.

### Hierarchy
Sizes outside Tailwind's scale are named once in `index.css`: `--text-title` (1.75rem, line height 1.25), `--text-nav` (0.95rem) and `--text-caption` (0.8125rem, line height 1.125rem).

- **Display** (600, 1.75rem, 1.25, `--text-title`): the page title, one per page ("Home", "Approval queue", a campaign's name). A short fact sits on the same baseline at the right in body size, muted and tabular ("Friday 13 November", "8 waiting, 0 decided", "Draft saved at 03:38").
- **Headline** (600, 1.25rem): the title of a wizard step ("Messages", "Review and start") and of a Settings group.
- **Title** (600, 1.125rem): section headings ("Needs you", "Campaigns", "Today’s usage", a Settings section), the dialog title, the sidebar's "Outreach", a held person's name in Needs review, and the number on a large score chip.
- **Figure** (600, 1.5rem, tabular): the funnel counts on a campaign's page and the percentages in Stats (there on a 28px line, with a small value beside a figure on the figure's baseline). The count tile's number is 1.25rem.
- **Body** (400, 1rem, 1.5): sentences, lead paragraphs (Ink, at most 42rem wide), field labels (at 500), the banner's text, text in a medium field.
- **Body small** (400, 0.875rem): tables (14px rows with 12px above and below each body cell), hints and secondary lines (muted), the activity log, the sidebar footer, small buttons (at 600), and the value in a small field.
- **Navigation** (400, 0.95rem, `--text-nav`): sidebar items; a campaign's name in a table uses the same size at 600. A campaign's name in the sidebar is body small and takes up to two lines, then an ellipsis, with the full name on hover; its dot stays on the first line.
- **Caption** (400, 0.8125rem, `--text-caption`): the muted caption over a quoted text ("Invite note", "First message, after they accept"), "Not finished" under a wizard step, the character count under a filled text, the column names of a stacked Stats block, the "Do not contact" badge, and extra-small buttons (at 600).
- **Label** (600, 0.75rem, tabular): the number in a wizard step circle and in a count badge. Nothing else is 12px.

Subheadings inside a card or an opened row ("Texts as sent", "History", "Preview", "Timings") are body size at 600.

### Named Rules
**The Three Weights Rule.** 400 for reading; 500 for a field label, the one line that names a row or state, and the words a variable filled in; 600 for headings, names, figures, buttons and the "Warning:" or "Error:" that leads a log line. Nothing is set at 700 and nothing is uppercase or letter-spaced.

**The Tabular Figures Rule.** Counts, times, scores, budgets and page ranges use tabular lining figures (the `.nums` class), so columns of numbers line up and a changing count does not shift its neighbours.

**The Unbroken Phrase Rule.** A date, a time or a count with its unit is one phrase and never breaks across lines ("1 December 2026", "Monday 09:00", "today at 07:38", "21 days", "5 campaigns", "24 to 48 hours"): the formatters in `format.ts` and `words.ts` join its words with no-break spaces (`unbroken`, `NBSP`, `plural`). A time in a table column is also `whitespace-nowrap`. A value standing alone in a column or a list starts with a capital ("Today at 07:38", "After you resume", "Every day counts").

**The Pretty Wrap Rule.** Every paragraph has `text-wrap-style: pretty`, so it never ends on one short word. Only the wrap style is set: the `text-wrap` shorthand would also reset the wrap mode and undo `whitespace-nowrap` on a paragraph.

## Layout

**Shell.** Two columns from 1024px: a fixed sidebar 16rem wide with a right hairline, and the page. Below 1024px the sidebar is a drawer opened from a top bar (a 44px menu button, "Outreach", and the session light with its label at the right). Banners span the full width of the page column, above the page content.

**Page.** Content is left-aligned in a column at most 1180px wide (`--container-page`), padded 16px at the sides and 24px top and bottom below 1024px, 40px and 32px from it. A page opens with the title block (`PageHeader`): the title row, then an optional lead paragraph with an optional action beside it. The title block owns the 24px under it, so a page's first block sets no top margin of its own.

**Rhythm.** Each relationship has one step, named once in `index.css`:
- `section` (2rem, 32px): between the sections of a page, and between the columns of a split layout.
- `block` (1.5rem, 24px): after the title block, and between the fields of a form.
- `group` (0.75rem, 12px): from a heading, a lead, a toolbar or a status line to the content it introduces.
- `card` (1.25rem, 20px): inside a card, a Settings section or an empty state.

Below those: 16px at the sides of a list row and 12px above and below it; 12px inside a toolbar; 6px from a label or hint to its control; 2 to 4px between stacked lines of text. A label and value list (`DEF_LIST`) is two columns from 640px (a 13rem label column, 16rem from 1280px) with 8px between rows; stacked below it, each label sits 2px over its value and the next label 12px under it, so the pairs read as pairs.

**Split layouts.** Home is one column until 1280px, then content plus a 21rem right rail (usage, recent activity). The wizard from 1024px is a 13rem step list plus the form. Needs review from 1024px is the facts plus a 22rem decision column. An opened person on a campaign's page from 1024px is the texts and the "Do not contact" card in the left column and a 17rem history column at the right, top-aligned; below it the order is texts, history, "Do not contact".

**Tables follow their own box.** A table is laid out by container queries on its own bordered box, never by the viewport. The widths are named in `index.css`; below its width a table changes form and keeps its table roles, so every cell keeps its column's name for a screen reader:

| Width | Value | From this width | Below it |
|---|---|---|---|
| `funnel` | 45rem | Home's and Campaigns' tables show the six funnel columns | one sentence under the name ("10 found, 8 invited, 0 replied"); on Campaigns each campaign is one block with its buttons in a row under it |
| `people` | 58rem | a campaign's People table has its columns | one block per person: name with the score chip and Profile at the right; headline and company, muted; stage in Ink with "Next: …" when there is one; the reason, muted |
| `people-wide` | 66rem | the People table also shows Company as a column | between 58rem and 66rem the company follows the headline after a middle dot, and the column stays for screen readers only |
| `queue` | 56rem | the approval queue's five columns (score, person, reason, texts, buttons) with a header row | the stacked row: score and person, then the reason, the texts, and Approve and Reject side by side at full width |
| `stats` | 50rem | the Stats table's five columns | one block per campaign: name and status, then the four measures two to a line, each under its column's name, values level |
| `preview` | 44rem | the wizard's Messages fields show their preview beside the form (19rem, staying in view while the form scrolls) | the preview follows the form |

The People table's Next action column is hidden from the eye (kept for screen readers) when nobody on the shown page has a next action. A wide table that still does not fit scrolls sideways inside its own box; no page scrolls sideways at 390px.

**Viewport breakpoints and what changes.**
- 640px: a banner lays out in one row with its button at the right; the confirm dialog moves from a bottom sheet to the centre; the funnel strip goes from 3 to 6 across; the activity log goes from stacked lines to three columns (time, message, campaign); label and value lists become two columns.
- 1024px: the sidebar docks; controls return to pointer density; the wizard's step list moves from a horizontal strip to a left column; the approval queue's keyboard hint and key caps appear (they are about having a keyboard, not about width).
- 1280px: Home's right rail.

**44px below 1024px.** Below 1024px (the drawer layout) every control is at least a 44px target; from 1024px the desk keeps its pointer density. Buttons, fields, selects and menu items get a 2.75rem minimum height from one rule in `index.css`; an extra-small button takes the small size's text (0.875rem) and 12px padding; a field's text is 16px, so a phone does not zoom when it takes focus. A switch reaches 44px through its row: the label's box is stretched over the whole row. Radios reach it through their label rows' padding. A compact link in a line of text (a campaign's name, "LinkedIn profile", "All campaigns", "Download as CSV", "Change") gets a 44px minimum height with negative margins, so the target grows and the line keeps its height. The skip links are 44px too. A link inside a sentence is exempt.

## Elevation & Depth

Flat. The theme sets daisyUI's depth and noise to 0, and no component adds a shadow. Depth is tonal: Sidebar Sage for the sidebar and for panels that hold controls, Desk Paper for the page and for cards, and a 1px Hairline Sage border around anything grouped. The only layers above the page are the modal dialog on the browser's dimmed backdrop, the drawer menu with its overlay below 1024px, and the Settings save bar, which stays at the bottom of the window with a top hairline.

### Named Rules
**The Flat Desk Rule.** Surfaces are told apart by tone and a 1px hairline, never by a drop shadow.

## Shapes

Gently rounded and consistent. Two radii do nearly all the work: 6px (`field`) for buttons, fields, selects, textareas, score chips, notices, the box of a failed action, code blocks, sidebar items, wizard steps and the skip links; 8px (`box`) for cards, tables, lists, toolbars, panels, the session card, the count tiles, the meters and the box of a failed load. A notice and a failed action are one shape: both 6px. Count badges and switches use the 16px `selector` radius and read as pills. Status dots and wizard step circles are circles.

Borders are 1px Hairline Sage; a control's own edge is 1px Control. Grouped rows are separated by 1px dividers inside one bordered box, not by separate cards. A quoted text (what a prospect will receive, the wizard's preview, a text as sent) is marked by a 2px Hairline Sage rule on its left with 12px of padding. There are no side stripes in status colours.

**Marks.** The small marks are a closed set, each with its own shape:
- **Filled dot** (8px): a state that is live, in the colour of the status map.
- **Ring** (the same dot, hollow, 1.5px edge in its own colour): something that is not working and needs nothing from the user: a campaign that is a draft, paused, finished or archived, and the session light at "Not checked yet" or "Search limit reached". Nothing else uses the ring.
- **Warning triangle** (14px, Ink outline with "!"): a warning line in a log. It is not the ring and not amber.
- **Wizard step circle** (24px, number at 12px 600): Hairline Sage with an Ink number when idle; light on Dark Moss for the current step; Score Mint with a Desk Green check when done; Hairline Sage with a 1.5px Ink edge (an inset ring) for a step passed but not finished, with "Not finished" under its name from 1024px; Desk Paper with a 2px Stop Red edge and a Stop Red number for a step with a problem.
- **Chevron** (14px, the drawn icon): every folded part. It points right when closed and turns a quarter when open. The browser's own triangle is removed from every `summary`.

## Components

### Buttons
Built on daisyUI's button, mostly at the small size (2rem high, 0.875rem, 600); the extra-small size (1.5rem high, 0.8125rem) sits inside table rows, the session card and the variables panel. The recipes live in `formParts.tsx`, so each look is decided in one place.
- **Shape:** softly rounded (6px), 1px border, no shadow.
- **Primary:** Desk Green with white text. One per view at most. The wizard's "Start the campaign" is the medium size (2.5rem).
- **Secondary** (`SECONDARY_BUTTON`): Desk Paper with a Hairline Sage border and Ink text, Sidebar Sage on hover. Every other action: "Back", "Re-check", "Pause", "Resume", "Open review", "Try again", "Back up now", "Edit messages and timings".
- **Halted Pause** (`HALTED_PAUSE`, added to the secondary button): Pause on a campaign a safety stop has already halted keeps its border and takes muted words, on Home, Campaigns and the campaign's page. It steps back and is still a button.
- **Quiet** (`QUIET_BUTTON`): no fill and no border, muted words at 500, for an action that must not compete with what sits beside it: Archive in a campaign's row, and the drawer's Close.
- **Approve / Reject:** Approve is Desk Paper with a Desk Green edge at 50%, Desk Green words and a check; Reject is the secondary button with an X. From 1024px each shows its key cap (A, R).
- **Selected:** Dark Moss with light text (`aria-pressed`), for the chosen segment of a joined filter ("Any, 5+, 6+, 7+, 8+", "Everything / Warnings and errors") and a working day that is on. Unselected segments are the secondary button.
- **On red** (`ON_RED_BUTTON`): white with Stop Red text and a white edge at 40%, for Resume and Re-check inside a red banner or the red session card.
- **Destructive:** the red button, only as the confirm of a dialog (Archive, Start with auto-approve on).
- **Busy:** a small spinner before the label while the request runs. A page button is disabled while it works, so its result takes the focus afterwards (see Failures). A confirm dialog's button is different: see Confirm dialog.
- **Text links:** underlined on hover only; body small ("All campaigns", "Activity log", "Change") or a name at 600. A link to a LinkedIn profile carries the external icon and says "(opens in your browser)" to screen readers.

### Badges and chips
- **Count badge:** a small amber pill with a tabular number at 600, at the right of "Approval queue" and "Needs review" in the sidebar. Hidden at zero.
- **Count tile:** an amber block 2.75rem high and at least as wide (8px radius) with the number at 1.25rem 600, opening each row of "Needs you". When nothing waits, the tile is Score Mint with a Desk Green check.
- **Score chip** (`ScoreChip`): a square with the score, 600, tabular. 2.5rem in the approval queue (number at 1.125rem), 1.75rem in a campaign's People table. Filled to empty: mint from 7, sage from 5, an outline below 5 or when not scored ("–"). Never amber or red.
- **Status line** (`StatusLine`, `StatusDot`): the mark from the status map followed by its words; in the sidebar's campaign list the dot stands alone beside the name and the words are for screen readers and the hover title.
- **Do not contact:** a small borderless badge, Stop Red words on Stop Red at 10%, at the caption size.
- **Key cap:** daisyUI's small `kbd` for A, R and the arrow keys.

### Cards / Containers
- **Card:** 8px radius, 1px Hairline Sage border, Desk Paper, no shadow, 20px padding (`card`). Rows inside a list card are divided by hairlines with 16px at the sides. A row of another kind inside the same card (in Budgets, "Days invites stay off", a cool-down after LinkedIn's own limit, not an allowance) stands under a hairline with 24px on each side, with no new card or heading.
- **Toolbar** (`TOOLBAR`): 8px radius, Sidebar Sage, no border, 12px padding, 12px above the list it filters. The usage panel (16px padding) and the variables panel are the same surface.
- **Section head** (`SectionHead`): the section's heading (1.125rem 600) with a link or button about the whole section at its right, on one baseline, 12px above the content.
- **Funnel strip:** one bordered box split by hairlines into six cells (three across below 640px), each a figure over a small muted label.
- **Empty state** (`EmptyState`): a card with one sentence at 500, one muted line saying what will appear there, and sometimes one button. An empty approval queue with no filter set is the title and the empty state alone: no toolbar and no count.
- **Notice** (`Notice`): 6px radius, 12px by 8px padding, Ink text, no border and no icon, in two tones. `waits` (amber at 20%): someone waits on the user ("Why: …" on a person held for review). `note` (Sidebar Sage): plain information to know before acting (what a live edit will affect, "What you do by hand on LinkedIn also counts.", an optional feature that is not set up, a text in the preview that cannot be written for one person yet: "No value for {{company}} for this person.").
- **Loading** (`SkeletonRows`): a few skeleton bars of row height inside the list's own bordered box, so the page keeps its shape when the rows arrive; loading dots in the session card, which keeps its loaded height.
- **Announce** (`Announce`): a live region (`role="status"`) that is always in the page and draws no box. It holds the visible result of an action (a Desk Green sentence, "Saved.") and can say a message to a screen reader alone.
- **Disclosure** (`Disclosure`): a folded part of a page: the summary line with the chevron ("Follow-up, if they do not reply", "For your AI coding tool").
- **Label and value list** (`DEF_LIST`, `DEF_TERM`): muted labels and Ink values, as described under Layout: a campaign's "Messages and timings" and every step of the wizard's review. The recipe owns its columns: a 13rem label column from 640px, 16rem from 1280px, so the longest label ("Withdraw an unaccepted invite after") is one line at desktop width.

### Failures
One pattern for everything that fails, built by `failure()` in `words.ts`:
- **What it says.** The app's own sentence says what failed, what state things are in and what to do ("The draft was not saved. Your changes are still on this page; press Save and continue again."). What came back is set under it, apart, in the muted tone: "What the app said: …" for the app's answer, or the dashboard's own sentence when the app did not answer at all. The server's words are never glued on after a colon.
- **Failed action** (`ActionError`): `role="alert"`, 6px radius (a notice's), Stop Red at 10%, 12px by 8px padding, body small; the app's sentence in Stop Red and the detail muted (about 5.1:1 on the tint, measured here). Its words are `FailureWords`, the one piece every failure is drawn with, so none can drift: the wizard's save and Start, the live edit, Settings' save bar (the failure replaces the bar's status line, inside its live region, `announce={false}`), Test the AI (a test that did not run, or an AI that answered with a problem), a backup, Pause or Resume, Do not contact, a decision, and Re-check beside the sidebar's or Settings' button. On the red "LinkedIn needs you" banner, Re-check's failure is `FailureWords` on red: light ink at 500, the detail at 90%.
- **Failed load** (`LoadError`): `role="alert"`, a box with a Stop Red edge at 40% on a 5% tint and 16px padding: "Could not load the stats. Nothing was changed; press Try again." with the detail under it and a secondary "Try again".
- **Field error** (`FieldError`): the control takes the error edge and one line of Stop Red body small appears 4px under it, `role="alert"`, ending as a sentence.

### Tables and lists
- **Table:** daisyUI's small table inside a bordered box that follows its own width (see Layout). Header cells are body small at 500, muted; number columns are right-aligned and tabular. The first cell holds a name at 600 with its status line under it.
- **Approval queue:** a grid with table roles. Each row: score chip; the person (name at 600, headline, company and place muted, the campaign muted, profile link); why the AI picked them (the reason, then the evidence for industry and size, muted); what they will receive (quoted texts under captions, the follow-up folded away); and Approve / Reject. The row that holds the focus is tinted Sidebar Sage at 60%.
- **Filled text** (`FilledText`): a text as it will be or was sent, with the words its variables filled in for this person at 500, so the fixed words and the personal ones read apart. The filled words are read from the template's own `{{variable}}` positions, never by searching for the person's values, so a fixed word that happens to equal a value stays plain; a text that does not follow its template shows plain throughout. Used in the approval queue, an opened person's "Texts as sent" and the wizard's preview.
- **Opened person:** in a campaign's People table, pressing a name opens a full-width cell tinted Sidebar Sage at 60% with the texts as sent, the history and the "Do not contact" switch in its own card. A stage that waits on the user leads with an amber dot at 500; a closed stage is muted, except a sequence stopped because the person replied, which stays Ink.
- **Activity line:** time (tabular, muted), sentence, and in the activity log the campaign at the right (muted). A warning leads with "Warning:" and an error with "Error:" at 600; an error's words are Stop Red; a safety stop's line already leads with "Safety stop:" and takes no "Error:". A mark ends the time column, so every line's text starts at one edge: the Ink triangle for a warning, the filled red dot for an error, nothing for information. The time and its mark are one line high, on the first line of a sentence that wraps.
- **Pager:** "Showing 1 to 20 of 20" at the left, muted; joined Previous / "Page 1 of 3" / Next at the right, only when there is more than one page.

### Inputs / Fields
- **Style:** daisyUI input, select and textarea with a 1px Control edge, 6px radius and a Desk Paper fill. Medium height in the wizard, small in Settings and in filters; a small field shows its value at 14px, the size of the sentence and buttons beside it. Placeholders are the muted tone. Numeric fields are narrow (5 to 8rem) and tabular, often set inside a sentence.
- **Field** (`Field`): label at 500, an optional muted hint at body small under it, then the control 6px below, then the error line. The control is described by its error line first, while it shows, then by its hint (`aria-describedby`, through `errorProps` and `hintIdOf`), and is marked `aria-invalid` while it has an error. One control of a group that shares an error line (a range, a time pair) points at the group's line (`describedByError`) only while it is marked itself: text in "Longest gap" marks that box alone, and a valid neighbour is not described by its error. A rule about the pair (the shortest above the longest, the end of the working day before its start, a wait's shortest above its longest) marks both controls with the error edge and `aria-invalid`.
- **Switch** (`SwitchRow`): daisyUI toggle at the left of its label (500) and muted hint; Control when off, Desk Green when on, the error tone when it has an error. Every switch is Desk Green when on, including auto-approve and "Do not contact". The switch points at its hint and its error line like any field.
- **Radio choice:** a small Desk Green radio with a label; a discovery source is a whole bordered card that takes a Desk Green edge and a mint fill at 40% when chosen.
- **Variable buttons:** extra-small secondary buttons at 400 in a Sidebar Sage panel, each a name plus its `{{variable}}` in muted text; pressing one inserts it at the cursor.
- **Character counts:** the invite note's field says "Template: 29 characters" (Stop Red at 500 past 300); the preview says the filled text's length, "19 of 300 characters".
- **Save bar:** in Settings, "Save settings" and "Undo changes" sit in a bar that stays at the bottom of the window, Desk Paper with a top hairline. One line beside the buttons says the state ("You have changes that are not saved.", "Settings saved."); a refused or failed save replaces that line with the failure, so the bar never says two things at once.
- **Preview:** the wizard's and the live edit's preview fills the texts in for the first people (or an invented one). A mistake in a template (a variable that does not exist, broken braces, a note too long) is the same for everyone, so it is said once above the people, in Stop Red, naming the text and ending as a sentence ("Follow-up: {{oops}} is not a variable."), the tone the field shows it in after a save; that text is then left out of each person's block. A text that cannot be written for one person yet is a `note` notice in that person's block, never amber.

### Navigation
- **Sidebar:** Sidebar Sage, 16rem, right hairline. From the top: "Outreach", the session card, the menu, and at the bottom the working window in two muted lines ("Working Mon to Fri, 09:00 to 18:00. Working now, until 18:00."). Boxes start 12px in; text starts 24px in.
- **Items:** daisyUI menu, 0.95rem, 6px radius. The current item is Dark Moss with light text, and exactly one item is current on every page (`currentNavTarget`): a campaign's own entry on its page, and "Campaigns" throughout the wizard and on an archived campaign's page. Campaigns are nested one level under "Campaigns" at body small, each with its status dot. A 12px gap separates the three groups (what needs the user; campaigns; activity, stats and settings), with a hairline before the last.
- **Session card:** a Desk Paper box with the session light and label at 500 ("Logged in"), "Last checked 17:56" in muted, and an extra-small Re-check. During a safety stop the whole card is Stop Red with white text: "Safety stop: security check, since 17:56." at 600, then one plain line on the dedicated window with no light, so nothing on the card reads as all clear, and Re-check as the on-red button under it.
- **Phone drawer:** below 1024px the sidebar slides in over an overlay as a modal: the page behind is inert, focus starts on the menu's first link, Escape, the overlay and following a link close it, and focus returns to the menu button. It has its own 44px Close button (the quiet recipe with the X icon, "Close menu") at the top right, so a touch screen reader can close it from inside.

### Focus
- **One indicator.** A 2px Ink outline, 2px outside, on everything that takes focus from the keyboard: links, summaries and focusable regions (14.7:1 on Desk Paper, 13.5:1 on Sidebar Sage). Buttons, fields, switches and radios keep daisyUI's own 2px outline in the same family. A menu item draws it inside its box (its neighbours are 2px away); on the current item it is light ink (12.3:1 on Dark Moss). The approval rows below are the one exception.
- **Approval rows** take a 2px inset ring in Dark Moss instead of an outline, with the Sidebar Sage tint, so the ring is not clipped by the list's box.
- **Skip links.** "Skip to content" on every width and "Skip to menu" from 1024px wait above the top edge and move into the top-left corner when the keyboard reaches them: Desk Paper, hairline border, 6px radius, 500.
- **Where focus moves.** A new page takes focus at its title, unless the page has already put it on something of its own (the wizard's Name field). A wizard step change moves it to the new step's heading. Headings and the page region take focus from a script only and show no ring. After a refused save the focus moves to the first field that was marked, brought to the middle of the window (`focusFirstError`, `focusInView`); in a range it is the box that is itself wrong, and when the rule is about the pair, the first of the two; when no field is marked, or the button that failed was disabled while it worked, the failure's message takes the focus (Pause or Resume, Do not contact, Re-check, Test the AI, a backup, a failed Settings save, a refused Start, whose summary names the steps to fix). After a decision the focus moves on with the user: in the approval queue to the next row (or the one before, when the last row left), in Needs review to the next person's card (or the one before); when nobody is left, the empty state takes it (`EmptyState` with an `id`). In the approval queue a failed row's message is announced and the focus stays where the user is deciding.

### Safety-stop banner
The one alarm. A full-width Stop Red bar above the page on every screen, with `role="alert"`: the stop icon (28px), "Safety stop. All LinkedIn activity is stopped." at 600, what LinkedIn showed, "What to do: …", when it stopped in body small, and a white Resume at the right. Below 640px the icon sits beside the heading, centred on its first line, and Resume spans the full width under the words. Resume opens the confirm dialog ("Resume LinkedIn activity?", "I have done this, resume", "Not yet"). The same bar, headed "LinkedIn needs you." with Re-check, is used when the session needs the user and no stop has been raised yet.

While a stop is active, the sidebar's session card is red, campaigns that would be working show a red dot and "Stopped by safety stop", the Campaigns header says only "5 campaigns" (the banner right above and the table already say which are stopped), and the sidebar footer reads "Nothing runs on LinkedIn until you resume."

The quiet counterpart is the unreachable banner: an amber bar with one sentence and no button (`role="status"`), when the app does not answer.

### Budget meter
One per budget in "Today’s usage": the name at the left, "7 of 11" at the right (the used count at 600, the limit muted), and an 8px bar under them with a Control edge (3.2:1 on the usage panel). With room, the fill is Desk Green on a Hairline Sage track. Spent, the fill is the control tone on a Desk Paper track: lighter than the green bars and than the muted words, so a full meter reads as finished and quiet and is never the darkest block in the card; a meter spent below its number (the week's invite budget, LinkedIn's own limit) still shows its fill against the track (about 3.5:1, measured here). The caption under it is muted and has one form in every state: "Budget spent; it resets Monday 09:00". During warm-up the invite budget's caption is "Warm-up: today’s allowance, rising to 15 a day".

### Wizard step bar
Seven numbered steps. From 1024px a 13rem left column; below it a horizontal strip under a muted line "Step 5 of 7: Messages". Each step is a 44px-high target below 1024px: its circle (see Marks) and its name at body small. The current step is Dark Moss; others take a Sidebar Sage hover; steps that cannot be opened before the draft exists are muted. The strip shows whole steps only: it snaps to a step's start, and on a step change it scrolls just far enough to show the current step in full. A step cut by the right edge fades from 45% to nothing as the sign that the strip scrolls, or is hidden when its circle would be sliced.

Below the form a top hairline separates Back and "Save and continue" (or "Save and review"). The review lists every step with the same marks (a bare Desk Green check when done) and "Change". While steps are unfinished, a plain Ink sentence above Start names them ("Who fits and Messages are not finished yet."), and Start points at it. Nothing is red before Start is pressed. After a refused Start a field's error sits under its own row's value and does not repeat the row's label ("Write the first message." under First message); a field named like its step does not repeat the name inside that step's block, and only an error with no row of its own (the AI line's instructions) is named, under the list. The summary names the button as it is: "…then press Start the campaign again."

The page header's fact says how the draft stands: "Saving…" while a save the user asked for runs, "Draft saved at 03:38" after one went through, and, while a save error shows (refused or failed, with none through since), "Not saved. Last saved at 03:38." or "Not saved yet." when it never was. Never "Draft saved" above "The draft was not saved."

### Confirm dialog
The native `dialog` with daisyUI's modal: a bottom sheet below 640px, centred from it, at most 32rem wide. Title at 1.125rem 600, one or two sentences, a failure in the failed-action box when there is one, then the actions at the right: a secondary way out ("Cancel", "Not yet") and one action that says what it does ("Approve 8", "I have done this, resume"). A destructive action uses the red button. Escape and the backdrop cancel. While the action runs the confirm button keeps its fill and the focus, shows a spinner and says what it is doing ("Approving…", "Archiving…", "Resuming…", "Starting…"; "Working…" by default), and ignores a second press (`aria-disabled` and `aria-busy`, not `disabled`, which would drop the focus to the page); Cancel is disabled, and Escape and the backdrop do nothing until the action ends, so a failure is shown where it was asked for.

### Icons
Seven line icons drawn inline in `src/ui/icons.tsx`: check, X, menu, stop (an octagon with an exclamation mark), external link, chevron and warning (a triangle with an exclamation mark). All are 24px-grid outlines with a 1.8 stroke, round caps and joins, in the current text colour, shown at 14 to 28px. Nothing else in the product is an icon; meaning is carried by words.

### Motion
For state changes only. One deceleration, `--ease-settle` (`cubic-bezier(0.25, 1, 0.5, 1)`, a quartic ease-out), and two lengths:
- **Row fold** (`--duration-leave`, 150ms): a decided approval row folds to nothing as an inert copy and fades, so the rows below close the gap instead of jumping.
- **Appear** (`--duration-appear`, 120ms): what a press opened fades in: an opened person's detail and the next wizard step.
- **Chevron** (120ms, the same curve): turns a quarter when its row or disclosure opens.
- **Scroll:** the wizard strip scrolls smoothly to the current step, and a message or field that takes the focus after a refusal scrolls smoothly to the middle of the window.

Buttons, switches, the drawer, spinners and skeletons keep daisyUI's built-in transitions. Under `prefers-reduced-motion: reduce` every transition and animation is set to zero and the scripted scrolls are instant; loaders keep turning, since a still spinner reads as a stuck app.

### Copy
- **Vocabulary.** UI text uses the terms of `CONTEXT.md`: person, prospect, campaign, discovery, scoring brief, approval queue, needs review, sequence, step, stage, budget, safety stop, working window, dedicated window, session. A pause is the user's choice on one campaign; a safety stop halts everything; a spent budget is never "paused".
- **Sentences end with a full stop.** Every activity line, field error, failure message, review problem line and status sentence ends with exactly one full stop (`withStop`, `asSentence`), unless it ends with "!", "?" or "…". Captions and labels are not sentences and take none: a budget caption, a pager's range, a column value.
- **Nothing promises a time during a safety stop.** While a stop is active no sentence says when work will happen: a waiting discovery says only what stays true ("LinkedIn’s monthly search limit is reached. It resets on 1 December 2026."; outside a stop it "resets on" too, as a budget does), a prospect's next step of the app's reads "After you resume" in place of a time, while a person who waits on the user's own decision (waiting for approval, needs review) shows nothing planned, as outside a stop, Approve all and the wizard's Start say the work begins "once you resume", and a spent budget says when it resets, which is true either way.
- **Typographic apostrophes.** Every apostrophe the user reads is ’ ("Today’s usage", "LinkedIn’s recommendations", "today’s allowance"), never the straight one. The dashboard's own strings are written so (`src/ui/apostrophes.test.ts` scans every string and piece of JSX text in `src/ui`); the server's words keep the straight one at their source (D-10) and `withStop` turns each one between letters into ’ wherever the dashboard shows them (log lines, errors, "What to do").
- **`plainMessage`.** The engine's log lines are put in the app's words where the activity log and Home show them, and the server's strings stay as they are: no underscores or field keys ("Edited: Messages, Timings."), "Checked LinkedIn: logged in.", "the daily budget of 10 … is spent", "Outside the working window: …". Where the row shows the campaign beside the line (the activity log) the line does not name it again ("Paused by you."); where it does not (Home) the name stays, always in quotes.

## Do's and Don'ts

### Do:
- **Do** keep one theme: Desk Paper page, Sidebar Sage sidebar and panels, 1px Hairline Sage borders, no shadows.
- **Do** set text in Ink or in the solid muted tone (`--color-muted`), and give a control's edge the control tone (`--color-control`).
- **Do** keep solid Stop Red bars and panels for the safety stop and for "LinkedIn needs you", and show a spent budget as a control-tone meter with the muted caption "Budget spent; it resets …".
- **Do** pair every status mark with its words, using the status map: a filled dot for a live state, a ring for a campaign that is not working, the Ink triangle for a log warning.
- **Do** use the `field` radius (6px) for controls, chips, notices and failed actions, and the `box` radius (8px) for cards, tables and panels.
- **Do** space a page with the four named steps: `section` 32px, `block` 24px, `group` 12px, `card` 20px.
- **Do** set every count, time, score and budget in tabular figures, and join a date or a count with its unit with no-break spaces through the formatters.
- **Do** lay a table out by its own box (the named container widths) and give it a stacked form below its width that keeps its table roles.
- **Do** keep every control a 44px target below 1024px, and every page free of sideways scrolling at 390px.
- **Do** build buttons, notices, failures, empty states and fields from the shared recipes in `formParts.tsx`.
- **Do** say a failure in the app's words (what failed, what state things are in, what to do), with "What the app said: …" apart and muted, and move the focus to the field or the message.
- **Do** write status as a plain sentence in the vocabulary of `CONTEXT.md`, ending with one full stop.
- **Do** keep one Desk Green primary button per view and make every other action secondary or quiet.
- **Do** use the two motion lengths (150ms to leave, 120ms to appear) with `--ease-settle`, for state changes only.

### Don't:
- **Don't** make a spent budget, a pause or a wait look like a safety stop. A spent budget is the control tone, a pause is a Dark Moss ring, a wait is amber; only a stop or "LinkedIn needs you" is a red bar.
- **Don't** use amber for anything that does not wait for the user: not a spent budget, not a score, not a past log line, not a button.
- **Don't** use the filled red dot for a form error; a wizard step with a problem is its number in a Stop Red edge.
- **Don't** use the ring for anything but something that is not working and needs nothing from the user (a campaign that is not working, a session not checked yet or at its search limit).
- **Don't** let a light disagree with its banner: a session that raises "LinkedIn needs you" has the red dot, not amber or Dark Moss.
- **Don't** write a straight apostrophe in a string the user reads; use ’.
- **Don't** show a status by colour alone.
- **Don't** set text as an opacity of Ink.
- **Don't** add drop shadows; the theme's depth is 0.
- **Don't** add a side stripe in a status colour to a row or a log line.
- **Don't** set text at 700, in uppercase or with letter-spacing; the system uses 400, 500 and 600 in sentence case.
- **Don't** add a second typeface or load a web font; the dashboard uses the Mac's own Seravek.
- **Don't** promise a time for any work while a safety stop is active.
- **Don't** glue the server's words onto a message after a colon.
- **Don't** set `text-wrap` on paragraphs; set `text-wrap-style`, or `whitespace-nowrap` stops working on them.
- **Don't** move anything on page load or for decoration.
- **Don't** use the browser's triangle for a folded part; use the drawn chevron.
