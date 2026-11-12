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
  error: "#b3352b"
  error-content: "#ffffff"
  success: "#2f7a4e"
  success-content: "#ffffff"
  info: "#33698f"
  info-content: "#ffffff"
  secondary: "#3d5a6c"
  secondary-content: "#ffffff"
  neutral: "#26302b"
  neutral-content: "#f2f4f0"
  base-100: "#f7f8f5"
  base-200: "#edefea"
  base-300: "#dce0d8"
  base-content: "#1d2521"
  score-high: "#d5e8dc"
  score-mid: "#f6e3bb"
  score-mid-content: "#5c3f07"
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
  label:
    fontFamily: "Seravek, Avenir Next, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
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
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
    padding: "0 12px"
  button-outlined:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    typography: "{typography.button}"
    rounded: "{rounded.field}"
    height: "2rem"
    padding: "0 12px"
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
    rounded: "{rounded.selector}"
  count-tile:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-content}"
    rounded: "{rounded.box}"
    size: "2.75rem"
  score-chip-high:
    backgroundColor: "{colors.score-high}"
    textColor: "{colors.primary}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  score-chip-mid:
    backgroundColor: "{colors.score-mid}"
    textColor: "{colors.score-mid-content}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  score-chip-low:
    backgroundColor: "{colors.base-200}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.field}"
    size: "2.5rem"
  card:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.box}"
    padding: "16px"
  panel:
    backgroundColor: "{colors.base-200}"
    textColor: "{colors.base-content}"
    rounded: "{rounded.box}"
    padding: "12px"
  input:
    backgroundColor: "{colors.base-100}"
    textColor: "{colors.base-content}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
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

This file records the dashboard as it is built today (branch `feat/ui-refine`, before any refinement). Every value comes from `src/ui/index.css`, the components under `src/ui/`, and the screenshots in `docs/milestones/img/before/`. It describes; it does not propose.

## Overview

**Creative North Star: "The Quiet Desk"**

The theme's own comment in `src/ui/index.css` states the idea: a quiet green-grey desk, amber for what waits on the user, red only for a safety stop. The dashboard is a light, flat, single-theme workspace. A sage sidebar sits on the left, the page is warm off-white paper, and almost everything on it is dark ink text, hairline borders and numbers. Colour is spent on meaning: green for the main action and for work that is running, amber for what waits, red for a safety stop.

The density is that of a working tool. Tables and lists carry real sentences ("prospects are waiting for your approval.", "Limit reached, resumes tomorrow 09:00") in place of labels and icons. There are five icons in the whole product, no illustrations, no imagery and no logo. There is one typeface in three weights. The user reads, decides and leaves.

There is no dark theme (`prefersdark: false`, `color-scheme: light`) and no authored motion.

**Key Characteristics:**
- One light theme: off-white page, sage sidebar, hairline borders, no shadows.
- One sans family (Seravek, the macOS system humanist sans) in weights 400, 500 and 600.
- Colour carries status: green runs, amber waits, blue finds, red stops.
- Every status is a dot plus words; colour never stands alone.
- Numbers are tabular everywhere a count, time or score appears.
- Two layouts from one build: a docked sidebar from 1024px, a drawer menu below it; nothing scrolls sideways at 390px.

## Colors

A green-grey neutral family with one deep green for action, one amber for waiting and one red for the safety stop.

### Primary
- **Desk Green** (`primary`, #2c5e4f): the main action on a screen ("Open queue", "Approve all 8 shown", "Save and continue", "Start the campaign"), the outline and text of the Approve button, the fill of a budget meter that still has room, the switch when on, the selected radio, the selected discovery source border, and short success sentences ("Saved.").

### Secondary
- **Waiting Amber** (`accent` and `warning`, #e5ad42, with `accent-content` #2b1d03 on top): what waits. The count tiles on Home, the count badges in the sidebar, the dot of a campaign waiting for approval, the "logged out" and "search limit reached" session light, the full meter of a spent budget, and the banner when the app does not answer. At 20 to 25% opacity it is the fill of a notice ("Held for review: …", "What you do by hand on LinkedIn also counts."). `accent` and `warning` are the same hex.

### Tertiary
- **Stop Red** (`error`, #b3352b, white text on top): the safety-stop banner, the "LinkedIn needs you" banner, and the sidebar session card while a stop is active. Outside those it appears as text (error sentences, an error line in the activity log), as a dot ("Stopped by safety stop", "Checkpoint", "Restricted"), and at 5 to 15% opacity behind an error message or the "Do not contact" badge.
- **Running Green** (`success`, #2f7a4e): the dot of a running campaign and of a connected session. Dots only.
- **Finding Blue** (`info`, #33698f): the dot of a campaign that is finding people. Dots only.
- **Slate Blue** (`secondary`, #3d5a6c): defined in the theme; no component uses it.

### Neutral
- **Desk Paper** (`base-100`, #f7f8f5): the page, cards, inputs and outlined buttons.
- **Sidebar Sage** (`base-200`, #edefea): the sidebar, filter toolbars, the usage panel, the variables panel, code blocks, the low score chip, skeletons, and (at 60%) the open or focused row.
- **Hairline Sage** (`base-300`, #dce0d8): every border and divider, the track of a meter, the idle step number in the wizard.
- **Ink** (`base-content`, #1d2521): all text. Secondary lines use it at 65% opacity and lead paragraphs under a page title at 75%.
- **Dark Moss** (`neutral`, #26302b, with `neutral-content` #f2f4f0): the selected state. The current sidebar item, the current wizard step, the chosen segment in a filter, a working day that is on, and the dot of a draft, paused, completed or archived campaign.
- **Score Mint** (`score-high`, #d5e8dc) with Desk Green text: the chip of a score of 7 or more; also the "Nothing needs you" tile and a passed AI test.
- **Score Sand** (`score-mid`, #f6e3bb) with `score-mid-content` (#5c3f07) text: the chip of a score from 5 to under 7.

### Status map
| Meaning | Colour | Form |
|---|---|---|
| Campaign running; session connected | Running Green | dot + words |
| Campaign finding people | Finding Blue | dot + words |
| Campaign waiting for approval; session logged out or search limit reached | Waiting Amber | dot + words |
| Campaign draft, paused, completed, archived; session not checked | Dark Moss | dot + words |
| Campaign stopped by a safety stop; session checkpoint or restricted | Stop Red | dot + words |
| Budget with room | Desk Green | meter fill |
| Budget spent ("Limit reached, resumes …") | Waiting Amber | full meter + sentence |
| Score 7 to 10 / 5 to under 7 / under 5 or not scored | Score Mint / Score Sand / Sidebar Sage | square chip with the number |
| Safety stop | Stop Red | full-width banner + red session card |

### Named Rules
**The One Alarm Rule.** A solid Stop Red bar or panel means LinkedIn needs the user: the safety-stop banner, the "LinkedIn needs you" banner, and the session card during a stop. A spent budget is amber and a pause is Dark Moss, so neither can be taken for a stop.

**The Amber Waits Rule.** Amber marks something waiting, whether on the user (a count to approve or review) or by itself (a spent budget until tomorrow). It is never the colour of a button.

**The Dot And Words Rule.** A status dot always sits beside its label ("Running", "Paused", "Stopped by safety stop"). No status is shown by colour alone.

## Typography

**Display Font:** Seravek (with Avenir Next, system-ui, sans-serif)
**Body Font:** the same family
**Label/Mono Font:** the browser's monospace stack, only for Terminal commands in Settings

**Character:** One humanist sans does everything. It is a font already on the user's Mac, so nothing loads from elsewhere (`src/ui/index.html` links no font). Hierarchy comes from size and from three weights, with kerning on and antialiased rendering.

### Hierarchy
- **Display** (600, 1.75rem, 1.25): the page title, one per page ("Home", "Approval queue", a campaign's name). A short fact sits on the same baseline at the right in body size, Ink at 65% ("Thursday 12 November", "8 waiting, 0 decided").
- **Headline** (600, 1.25rem): the title of a wizard step ("Messages").
- **Title** (600, 1.125rem): section headings ("Needs you", "Campaigns", "Today's usage", a Settings section), the dialog title, the sidebar's "Outreach", and a held person's name in Needs review.
- **Figure** (600, 1.5rem, tabular): the funnel counts on a campaign's page and the percentages in Stats. Count tiles use 1.25rem and large score chips 1.125rem.
- **Body** (400, 1rem, 1.5): sentences, field labels (at 500), lead paragraphs (Ink at 75%, held to about 36 to 42rem wide), text inside message boxes.
- **Body small** (400, 0.875rem): tables, secondary lines and hints (Ink at 65%), the activity log, the sidebar footer, button text (at 600).
- **Navigation** (400, 0.95rem): sidebar items; a campaign's name in a table uses the same size at 600.
- **Label** (400, 0.75rem): the small caption over a quoted text ("Invite note", "First message, after they accept") and the number in a wizard step circle (at 600).

Subheadings inside a card or an expanded row ("Texts as sent", "History", "Preview") are body size at 600.

### Named Rules
**The Three Weights Rule.** 400 for reading, 500 for a label or the one line that names a row, 600 for headings, names, figures and buttons. Nothing is set at 700 and nothing is uppercase or letter-spaced.

**The Tabular Figures Rule.** Counts, times, scores, budgets and page ranges use tabular lining figures (the `.nums` class), so columns of numbers line up and a changing count does not shift its neighbours.

## Layout

**Shell.** Two columns from 1024px: a fixed sidebar 16rem wide with a right hairline, and the page. Below 1024px the sidebar becomes a drawer opened from a top bar (menu button, "Outreach", and the session light with its label at the right). Banners span the full width of the page column, above the page content.

**Page.** Content is left-aligned in a column at most 1180px wide, padded 16px at the sides and 24px top and bottom on a phone, 40px and 32px from 1024px. A page opens with the title row, then an optional lead paragraph, then its sections.

**Rhythm.** Spacing follows the 4px Tailwind scale. The values that repeat:
- 32px between sections and between the two columns of a split layout.
- 20 to 24px between the title row and the first block, and between fields in a form.
- 12px between a section heading and its content, and between controls in a toolbar or a row of buttons.
- 16px inside cards and table rows (16px side, 12 to 16px vertical); 12px inside toolbars.
- 6px between a label or hint and its control; 2 to 4px between stacked lines of text.

**Split layouts.** Home is one column until 1280px, then content plus a 21rem right rail (usage, recent activity). The wizard from 1024px is a 13rem step list plus the form; the Messages step adds a 19rem preview that stays in view while the form scrolls. Needs review from 1024px is the facts plus a 22rem decision column. An expanded person on a campaign's page is the texts plus a 17rem history column.

**Breakpoints and what changes.**
- 640px: banners lay out in a row with the button at the right; the confirm dialog moves from a bottom sheet to the centre; the funnel goes from 3 to 6 across; the activity log goes from stacked lines to three columns (time, message, campaign).
- 768px: campaign tables show the six funnel columns; below it they show one sentence ("20 found, 10 invited, 1 replied").
- 1024px: the sidebar docks; the approval queue becomes a five-column grid with a header row and the keyboard hint and key caps appear; the wizard's step list moves from a horizontal scrolling strip to a left column.
- 1280px: Home's right rail.

On a phone, wide tables scroll inside their own bordered box, the approval queue stacks each prospect with Approve and Reject side by side at full width, and "Approve all shown" spans the width.

## Elevation & Depth

Flat. The theme sets daisyUI's depth and noise to 0, and no component adds a shadow. Depth is tonal: Sidebar Sage for the sidebar and for panels that hold controls, Desk Paper for the page and for cards, and a 1px Hairline Sage border around anything grouped. The only layer above the page is the modal dialog on the browser's dimmed backdrop, and the drawer menu with its overlay on a phone.

### Named Rules
**The Flat Desk Rule.** Surfaces are told apart by tone and a 1px hairline, never by a drop shadow.

## Shapes

Gently rounded and consistent. Two radii do nearly all the work: 6px (`field`) for buttons, inputs, selects, textareas, score chips, notices, code blocks, sidebar items and wizard steps; 8px (`box`) for cards, tables, lists, toolbars, panels, the session card and the Home count tiles. Count badges and switches use the 16px `selector` radius and read as pills. Status dots and wizard step numbers are circles.

Borders are 1px Hairline Sage. Grouped rows are separated by 1px dividers inside one bordered box, not by separate cards. A quoted text (what a prospect will receive, the wizard's preview, a text as sent) is marked by a 2px Hairline Sage rule on its left with 12px of padding.

## Components

### Buttons
Built on daisyUI's button, mostly at the small size (2rem high, 0.875rem, 600); the extra-small size (1.5rem high, 0.8125rem) is used inside table rows and the session card.
- **Shape:** softly rounded (6px), 1px border, no shadow.
- **Primary:** Desk Green with white text. One per view at most.
- **Outlined:** Desk Paper with a Hairline Sage border and Ink text, for secondary actions ("Back", "Re-check", "Pause", "Back up now", "Edit messages and timings"). Some are transparent instead of Desk Paper (the ghost variant with the same border); on the page they look the same.
- **Plain:** the daisyUI default (a Sidebar Sage fill, no visible border) for "Open" on Home and "Try again".
- **Approve / Reject:** Approve is outlined in Desk Green at 50% with Desk Green text and a check icon; Reject is the outlined button with an X icon. From 1024px each shows its key cap (A, R).
- **Selected:** Dark Moss with light text, for the chosen segment of a joined filter ("Any, 5+, 6+, 7+, 8+", "Everything / Warnings and errors") and for a working day that is on. Unselected segments are Desk Paper.
- **On red:** white with Stop Red text, for Resume and Re-check inside a red banner or the red session card.
- **Busy / Disabled:** a small spinner appears before the label while the request runs and the button is disabled; disabled buttons take daisyUI's faded style.
- **Text links:** underlined on hover only, body-small ("All campaigns", "Activity log", "Change"); external links to a LinkedIn profile carry the external icon.

### Badges and chips
- **Count badge:** small amber pill with a tabular number at 600, at the right of "Approval queue" and "Needs review" in the sidebar. Hidden at zero.
- **Count tile:** a 2.75rem amber square (8px radius) with the number at 1.25rem, 600, opening each row of "Needs you". When nothing waits, the tile is Score Mint with a green check.
- **Score chip:** a square with the score, 600, tabular. 2.5rem in the approval queue, 1.75rem in a campaign's people table. Mint for 7 and up, sand for 5 to under 7, Sidebar Sage with faded ink below 5 or when not scored.
- **Status dot:** daisyUI's small status circle in the colour from the status map, always followed by its label.
- **Do not contact:** a small borderless badge, Stop Red text on Stop Red at 15%.
- **Key cap:** daisyUI's extra-small `kbd` for A, R and the arrow keys.

### Cards / Containers
- **Card:** 8px radius, 1px Hairline Sage border, Desk Paper, no shadow. Padding 16px, or 20px in Settings sections and empty states. Rows inside are divided by hairlines.
- **Panel:** 8px radius, Sidebar Sage, no border. Holds controls or a summary: filter toolbars (12px padding), "Today's usage" (16px), the variables panel in the wizard.
- **Funnel strip:** one bordered box split by hairlines into six cells (three across on a phone), each a figure over a small label.
- **Empty state:** a card with one sentence at 500 and one line at 65% saying what will appear there, sometimes with one button.
- **Notice:** 6px radius, amber at 20 to 25%, Ink text, no border or icon. Says why something is held or what an edit will affect.
- **Error message:** Stop Red text on Stop Red at 10% (8px radius, 12px by 8px padding) for an action that failed; a bordered version (Stop Red border at 40%, fill at 5%) with "Try again" when a page could not load.
- **Loading:** daisyUI skeleton blocks at the size of the content they stand for; loading dots in the session card.

### Tables and lists
- **Table:** daisyUI's small table inside a card that scrolls sideways by itself. Header cells are body-small at 500, Ink at 65%; number columns are right-aligned and tabular. The first cell holds a name at 600 with its status line under it.
- **Approval queue:** a grid with table roles. Each row: score chip, the person (name at 600, headline, place and campaign at 65%, profile link), why the AI picked them (the reason, then industry and size evidence at 65%), what they will receive (quoted texts under small captions, the follow-up folded away), and Approve / Reject. A row that has focus is tinted Sidebar Sage at 60%.
- **Expandable row:** in a campaign's people table, clicking a name opens a full-width cell tinted Sidebar Sage at 60% with the texts as sent, the history and the "Do not contact" switch.
- **Activity line:** time (tabular, faded), sentence, campaign at the right. Warnings and errors start with "Warning:" or "Error:" at 500; errors are Stop Red text.
- **Pager:** "Showing 1 to 20 of 20" at the left; joined Previous / "Page 1 of 3" / Next at the right, only when there is more than one page.

### Inputs / Fields
- **Style:** daisyUI input, select and textarea with a 1px border, 6px radius and a Desk Paper fill. Medium height in the wizard, small in Settings and in filters. Numeric fields are narrow (5 to 8rem) and tabular, often set inside a sentence ("Between [45] and [180] seconds.").
- **Field:** label at 500, an optional hint at body-small 65% under it, then the control 6px below, then the error line.
- **Focus:** daisyUI's default focus outline; nothing custom.
- **Error:** the control takes the error border and one line of Stop Red body-small text appears under it.
- **Switch:** daisyUI toggle, Desk Green when on, set at the left of its label (500) and hint. The auto-approve and "Do not contact" switches use the amber tone when on.
- **Radio choice:** small radio with a label; a discovery source is a whole bordered card that takes a Desk Green border and a faint mint fill when chosen.
- **Variable buttons:** extra-small outlined buttons in a panel, each a name plus its `{{variable}}` in faded ink; pressing one inserts it at the cursor.
- **Save bar:** in Settings, "Save settings" and "Undo changes" sit in a bar that stays at the bottom of the window, Desk Paper with a top hairline.

### Navigation
- **Sidebar:** Sidebar Sage, 16rem, right hairline. From the top: "Outreach", the session card, the menu, and at the bottom the working window in two faded lines ("Working Mon to Fri, 09:00 to 18:00. Working now, until 18:00.").
- **Items:** daisyUI menu, 0.95rem, 6px radius. The current item is Dark Moss with light text. Campaigns are nested one level under "Campaigns" at body-small, each with its status dot. A 12px gap separates the three groups (what needs the user; campaigns; activity, stats and settings).
- **Session card:** a Desk Paper box in the sidebar with the session light and label ("Connected"), "Last checked 17:56" and an extra-small Re-check button. During a safety stop the whole card turns Stop Red with white text and names the stop.
- **Phone:** a top bar with the menu button, "Outreach" and the session light; the sidebar slides in as a drawer over an overlay and closes when a link is followed.

### Safety-stop banner
The one alarm. A full-width Stop Red bar above the page on every screen, with `role="alert"`: the stop icon (hidden on a phone), "Safety stop. All LinkedIn activity is stopped." at 600, what LinkedIn showed, "What to do: …", when it stopped in body-small, and a white Resume button at the right (full width under the text on a phone). Resume opens the confirm dialog. The same bar, with Re-check, is used when the session needs the user and no stop has been raised yet. While a stop is active, pausable campaigns show a red dot and "Stopped by safety stop", and the sidebar footer reads "Nothing runs on LinkedIn until you resume."

The quiet counterpart is the unreachable banner: an amber bar with one sentence and no button, when the app does not answer.

### Budget meter
One per budget in "Today's usage": the name at the left, "7 of 11" at the right (the used count at 600, the limit at 65%), and a 6px progress bar under them. The fill is Desk Green while there is room and amber when the budget is spent, with a sentence under it ("Limit reached, resumes tomorrow 09:00"; during warm-up, "Warm-up: today's allowance, rising to 15 a day").

### Wizard step bar
Seven numbered steps. From 1024px a left column; below it a horizontal strip that scrolls. Each step is a 1.5rem circle with its number and the step's name at body-small. The current step is Dark Moss with a light circle; other steps are plain with a Hairline Sage circle and a Sidebar Sage hover; steps that cannot be opened yet are at half opacity; a step with a problem has a Stop Red circle. Below the form, a top hairline separates Back and "Save and continue"; the last step's Start button is the medium size.

### Confirm dialog
The native `dialog` with daisyUI's modal: a bottom sheet on a phone, centred from 640px, at most 32rem wide. Title at 1.125rem 600, one or two sentences, then the actions at the right: an outlined way out ("Cancel", "Not yet") and one primary action that says what it does ("I have done this, resume"). A destructive action uses the red button. Escape and the backdrop cancel.

### Icons
Five line icons drawn inline in `src/ui/icons.tsx`: check, X, menu, stop (an octagon with an exclamation mark) and external link. All are 24px-grid outlines with a 1.8 stroke, round caps and joins, in the current text colour, shown at 14 to 28px. Nothing else in the product is an icon; meaning is carried by words.

### Motion
None is authored. Buttons, switches, the drawer, spinners and skeletons use daisyUI's built-in transitions, and a global rule sets every transition and animation to zero under `prefers-reduced-motion: reduce`.

## Do's and Don'ts

### Do:
- **Do** keep one theme: Desk Paper page, Sidebar Sage sidebar and panels, 1px Hairline Sage borders, no shadows.
- **Do** keep solid Stop Red bars and panels for the safety stop and for "LinkedIn needs you", and show a spent budget in amber with a sentence saying when it resumes.
- **Do** pair every status dot with its words, using the status map.
- **Do** use the `field` radius (6px) for controls and chips and the `box` radius (8px) for cards, tables and panels.
- **Do** set every count, time, score and budget in tabular figures.
- **Do** write status as a plain sentence in the vocabulary of `CONTEXT.md` (prospect, person, campaign, approval queue, needs review, safety stop, budget, working window).
- **Do** keep one Desk Green primary button per view and make every other action outlined.
- **Do** keep every page free of sideways scrolling at 390px; a wide table scrolls inside its own box.

### Don't:
- **Don't** make a spent budget, a pause or a wait look like a safety stop. They are amber or Dark Moss; only a stop is a red bar.
- **Don't** show a status by colour alone.
- **Don't** add drop shadows; the theme's depth is 0.
- **Don't** set text at 700, in uppercase or with letter-spacing; the system uses 400, 500 and 600 in sentence case.
- **Don't** add a second typeface or load a web font; the dashboard uses the Mac's own Seravek.
- **Don't** use amber for an action button; amber means waiting.
