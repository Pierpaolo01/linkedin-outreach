# The recommendations surface: My Network → Grow

For the lead and the user, who choose the recommendations page at gate 1. Facts come from one saved page: `https://www.linkedin.com/mynetwork/grow/`, in English, from the user's account on 2026-11-11, saved after several slow scrolls and without clicking anything. The capture holds real people's data and is not committed. The scrubbed copy is `fixtures/recommendations/grow-en.html`, and the parser is `src/linkedin/parse/recommendations.ts`. This note contains no names.

## What the page showed

The page content has four sections that each hold a list. The parser reads each one as a group.

| # | Heading (kind) | Cards loaded | "Show all" | Parser |
| --- | --- | --- | --- | --- |
| 1 | "Invitations (2)": invitations received, one from a person to connect and one to follow a company page | 2 items | link to `/mynetwork/invitation-manager/` | `other`, no cards |
| 2 | "People you may know from \<company\>": the company is one the user shares with them | 8 | yes | `people` |
| 3 | "People you may know in \<area\>": a place | 8 | yes | `people` |
| 4 | "Suggestions for you": a 4-wide grid, the one in the screenshot | 64 | none | `people` |

That makes 80 person cards and 80 distinct people. No one appears in two groups on this load. Every card's action is **Connect**. The page also has blocks that are not lists: a games promotion, the "Manage my network" sidebar with counts, and an ad slot. This load had no groups of company pages, newsletters, events or people to follow. The parser marks such groups `other` (no profile links, or only Follow buttons), but none of that rule was checked on a real page.

Rows 2 and 3 show their 8 cards in the markup without any click. The grid sits in a `data-testid="lazy-column"` container, which suggests it grows as the page scrolls; 64 cards had loaded after the scrolls made for the capture.

## What a card carries

| Field | Present | Notes |
| --- | --- | --- |
| Profile link `/in/<id>/` | always | the public id |
| Full name | always | |
| Headline | 80 of 80 | The markup holds the full text. The screen cuts it at two lines ("…"), and 15 headlines run past 100 characters |
| Insight line | 80 of 80 | One of three kinds: mutual connections ("\<first name\> and N other mutual connections" or "\<first name\> is a mutual connection") on 51 cards; a shared company or school name on 16, which on row 2 is always the company in the heading; "Based on your profile" on 13 (grid only) |
| Badges | some | verified, premium and "open to work", as `aria-label`s only |
| Action | always | the button "Connect". Its `componentkey` also holds the internal member URN (`urn:li:member:<n>`), which the parser does not use |
| Connection degree | **no** | |
| Location | **no** | |
| Current company as its own field | **no** | only inside the headline, or as the insight line where it is a shared company |

Compared with a people-search result, a card has no degree, no location and no separate current company. It also has no stable ordering or page number. The insight line (mutual connections, shared company) is something search results do not give in the same form.

## What "Show all" does, judging from the markup

On rows 2 and 3, "Show all" is `<a href="https://www.linkedin.com/mynetwork/grow/" aria-label="Show all suggestions for <heading>">`. The href is the Grow page itself, so the browser does not navigate anywhere useful and the page's script decides what happens. It probably opens a dialog or expands the row in place, but this cannot be determined from a saved page: the dialogs in the capture are ad menus. A driver cannot use this href as a URL for one group. It has to click the control and read what appears. The grid has no "Show all".

## Stable hooks found

- The page: inside `main`, the sub-navigation link `a[aria-current="true"]` points at `/mynetwork/grow/`. On Catch up, the Catch up tab is presumably current instead, but that page was not saved.
- Groups: a `section` that holds a `[role="list"]`, with an `h3` heading for the rows and an `h2` for the grid and the invitations.
- Cards: `[role="listitem"]`. The profile link is the first `a[href]` whose path is `/in/<id>`. Inside it, the first `p` is the name and the second is the headline. The insight line is the `p` outside that link.
- The action is the card's only button with visible text; the dismiss button has an icon only. "Show all" is a link or button next to the heading.
- The invitations group is the section linking to `/mynetwork/invitation-manager/`.
- Wording is used only for the action button text and for extracting the reason from the heading. It is kept for `en` and `it` in `src/linkedin/parse/selectors.recommendations.ts`, and every Italian string is marked unverified.

## What a `cursor` could be

This surface has no URL pagination and no visible page number, so a cursor cannot be a position. A workable cursor is:

- the set of public ids already collected (the real progress marker, kept in `discovery_runs`), and
- the titles of the groups already consumed, i.e. rows whose "Show all" has been opened and read to the end, plus whether the grid stopped growing on the last pass.

The source is exhausted when a full pass (load the page, scroll the grid until it stops growing, open each row's "Show all") yields no public id that has not been seen before. LinkedIn probably reshuffles suggestions between visits, so the set of seen ids matters more than the group titles.

## What one saved page could not settle

- What "Show all" opens, how many people it holds, and whether it paginates.
- Whether the grid ever ends, and how many cards it gives per scroll.
- Whether groups and their order are stable between visits.
- Which other group kinds this account gets: school, industry, recent activity, creators to follow, pages, newsletters.
- What a card looks like after Connect is clicked. The parser expects a "Pending" button, but that was not seen.
- Every Italian string: group headings, button texts, insight lines.
- Whether the user's own profile ever appears. It did not on this page, and the global navigation has no link to it, so the parser accepts the user's public id as an option.
