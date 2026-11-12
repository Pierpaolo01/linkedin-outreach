# Dashboard API

The JSON API the dashboard uses. The UI never touches LinkedIn: it reads and writes the database through these routes, and the engine acts on what it finds there. No route starts the engine, the AI or a browser, except `POST /api/session/check`, which opens the dedicated window to look at the session, and `POST /api/ai/test`, which asks the AI chosen in Settings two small questions about invented people.

Code: `src/server/` (routes), `src/campaigns/` (the rules and writes behind them).

## Conventions

- **Where.** The app listens on `127.0.0.1` only. Every request must carry `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`, otherwise `403 {"error":"Forbidden host"}`. A request other than GET or HEAD that carries an `Origin` header must come from `http://127.0.0.1:<port>` or `http://localhost:<port>`, otherwise `403 {"error":"Forbidden origin"}`. No CORS headers are sent. A same-origin `fetch` from the dashboard passes both checks.
- **Bodies.** JSON. Send `content-type: application/json` with a body. For a route that takes no body, send no body and no `content-type` (with that header and an empty body, Fastify answers `400 {"error":"Body cannot be empty when content-type is set to 'application/json'"}`). Where a body is optional, leaving it out is the same as `{}`. Unknown fields are refused (`"Unknown field"`).
- **Times.** Every timestamp is an ISO 8601 UTC string (`"2026-11-16T09:00:00.000Z"`) or `null`.
- **Ids.** `:id` is a positive whole number. Anything else (`abc`, `0`, `1.5`) answers 404 like an unknown id.
- **Paging.** List routes take `?page=` (1-based, default 1) and `?pageSize=` (1–200, default 50) and answer a **Page**: `{ "page": 1, "pageSize": 50, "total": 123, "items": [...] }`. `total` counts matching rows across all pages.
- **Errors.** Every error body has `error`, a sentence a person can read.

| Status | When | Body |
| --- | --- | --- |
| 400 | Input failed validation | `{ "error": "Some fields need attention", "fields": { "<path>": "<what to do>" } }`. Paths are dotted: `name`, `sourceUrls.1`, `limits.invitesPerDay`. A body that is not an object reports path `body`. `start` and live edits use their own `error` sentence (below). Unreadable JSON: `{ "error": "Body is not valid JSON but content-type is set to 'application/json'" }` (no `fields`) |
| 404 | Unknown id (also an unknown `campaignId` in a query or body) | `{ "error": "No campaign 7" }`, `"No prospect 7"`, `"No person 7"` |
| 409 | The campaign's status or the prospect's stage forbids the move | `{ "error": "Only a draft can be started; this campaign is running" }` |
| 403 | Host or Origin check | see above |
| 500 | A bug or a broken database | `{ "error": "Something went wrong in the app. The log has the details." }` |

## Shapes

### Campaign

```json
{
  "id": 1,
  "status": "draft",
  "name": "Founders in Milan",
  "discoverySource": "search",
  "sourceUrls": ["https://www.linkedin.com/search/results/people/?keywords=founder"],
  "targetProspectCount": 100,
  "scoringBrief": "Founders of small manufacturers…",
  "batchSize": 25,
  "autoApprove": false,
  "scoreThreshold": 7,
  "openProfileThreshold": 6,
  "inviteNote": "Hi {{first_name}}…",
  "firstMessage": "Thanks for connecting, {{first_name}}.",
  "followUp": "",
  "aiPersonalise": false,
  "personalisationInstructions": null,
  "acceptToMessageMinHours": 24,
  "acceptToMessageMaxHours": 48,
  "followUpDelayMinHours": 24,
  "followUpDelayMaxHours": 48,
  "delayPolicy": "calendar",
  "withdrawAfterDays": 21,
  "createdAt": "2026-11-16T09:00:00.000Z",
  "updatedAt": "2026-11-16T09:00:00.000Z",
  "funnel": { "found": 0, "approved": 0, "invited": 0, "accepted": 0, "messaged": 0, "replied": 0 }
}
```

- `status`: `draft | finding | awaiting_approval | running | paused | completed | archived`.
- `inviteNote`: `null` or `""` means no note. `followUp`: `""` means no follow-up.
- `funnel` counts prospects that **reached** each step, from their lifecycle timestamps (found = all prospects; approved = `approvedAt` set; invited = `invitedAt`; accepted = `acceptanceObservedAt`; messaged = `firstMessageSentAt`; replied = `replyDetectedAt`). A prospect stopped after a reply still counts as invited, accepted and messaged.

### Campaign fields (create and update body)

All optional. Each row is one wizard field.

| Step | Field | Type | Rule (400 message) |
| --- | --- | --- | --- |
| 1 | `name` | string ≤ 200 | |
| 2 | `discoverySource` | `"recommendations"` or `"search"` | default `recommendations` on create |
| 2 | `sourceUrls` | string[] ≤ 20 | people-search URLs, checked at start |
| 2 | `targetProspectCount` | whole number ≥ 1, or `null` | |
| 3 | `scoringBrief` | string ≤ 10000 | |
| 4 | `batchSize` | whole number ≥ 1 | default 25 |
| 4 | `autoApprove` | boolean | default false; `start` needs `confirmAutoApprove` |
| 4 | `scoreThreshold` | whole number 0–10 | default 7 |
| 4 | `openProfileThreshold` | whole number 0–10 | default 6 |
| 5 | `inviteNote` | string ≤ 2000, or `null` | |
| 5 | `firstMessage` | string ≤ 8000 | |
| 5 | `followUp` | string ≤ 8000 | |
| 5 | `aiPersonalise` | boolean | default false |
| 5 | `personalisationInstructions` | string ≤ 4000, or `null` | |
| 6 | `acceptToMessageMinHours`, `acceptToMessageMaxHours` | whole number of hours ≥ 0 | defaults 24, 48 |
| 6 | `followUpDelayMinHours`, `followUpDelayMaxHours` | whole number of hours ≥ 0 | defaults 24, 48 |
| 6 | `delayPolicy` | `"calendar"` or `"working_days"` | default `calendar` |
| 6 | `withdrawAfterDays` | whole number 1–365 | default 21 |

Template variables: `{{first_name}}`, `{{company}}`, `{{title}}`, `{{location}}`, `{{industry}}`, `{{ai_line}}`.

**Live edits.** Once a campaign has left `draft` (finding, awaiting approval, running, paused) only these may change: `inviteNote`, `firstMessage`, `followUp`, `aiPersonalise`, `personalisationInstructions`, the four delay fields, `delayPolicy`, `withdrawAfterDays`. A completed or archived campaign cannot be edited.

### Checks before start

Run by `start`, and on every edit of a started campaign (so a live campaign never holds a template the engine would refuse). Each failing field gets one message:

| Field | Message |
| --- | --- |
| `name` | `Give the campaign a name` |
| `sourceUrls` | `Add at least one LinkedIn people-search URL` (search only) |
| `sourceUrls.<i>` | `This is not a LinkedIn people search. Copy the address of a search on www.linkedin.com/search/results/people/` (must be `https://`, host `www.linkedin.com`, path starting `/search/results/people/`: exactly what the driver loads; `linkedin.com` and country subdomains such as `it.linkedin.com` are refused) |
| `scoringBrief` | `Describe who fits this campaign and who does not` |
| `firstMessage` | `Write the first message` |
| `inviteNote`, `firstMessage`, `followUp` | `{{x}} is not a variable. Use {{first_name}}, {{company}}, {{title}}, {{location}}, {{industry}} or {{ai_line}}` |
| same | `The braces do not match. Write variables as {{first_name}}` |
| same | `{{ai_line}} is written by the AI only when personalisation is on. Turn it on or remove {{ai_line}}` |
| `inviteNote` | `The invite note must be at most 300 characters with the variables filled in. With long sample values it comes to N.` |
| `openProfileThreshold` | `The open-profile threshold must not be above the score threshold (7)` |
| `acceptToMessageMinHours`, `followUpDelayMinHours` | `The shortest wait must not be longer than the longest (48 hours)` |
| `autoApprove` | `Auto-approve sends without your review. Confirm that this is what you want.` (send `confirmAutoApprove: true` with `start` to confirm) |

The invite note is measured with these long sample values: first_name `Maria Alessandra`, company `Example International Engineering and Consulting Group S.p.A.`, title `Head of Business Development and Strategic Partnerships`, location `Reggio nell'Emilia, Emilia-Romagna, Italy`, industry `Industrial Machinery Manufacturing`, ai_line a 147-character sentence.

### PreviewText

One rendered text, or why it cannot be written:

```json
{ "ok": true, "text": "Hi Anna, …", "length": 48 }
{ "ok": false, "problem": "unresolved_variable", "variables": ["title"], "message": "No value for {{title}} for this person" }
```

`problem` is one of `unresolved_variable` (`No value for {{x}} for this person`), `unknown_variable` (`{{x}} is not a variable`), `malformed` (`The braces do not match. Write variables as {{first_name}}`), `empty` (`The text is empty`), `too_long` (invite note only: `Longer than 300 characters (312)`). Texts are filled with the values the engine uses for that person, so a preview that renders is what would be sent. With personalisation on, a missing AI line shows as `[AI-written line]` only where the AI has not had its turn yet (the invented sample person and prospects still `found`); for any other prospect it is `unresolved_variable`, because the engine would hold that prospect for review rather than send.

### Person

```json
{
  "id": 1, "fullName": "Test Person 1", "firstName": "Test", "headline": "Founder at Example Company 1",
  "title": "Founder", "company": "Example Company 1", "location": "Milan, Italy",
  "profileUrl": "https://www.linkedin.com/in/test-person-1/", "connectionDegree": 2,
  "industryEvidence": { "value": "Machinery", "source": "profile", "confidence": 0.8 },
  "sizeEvidence": null, "doNotContact": false, "contactedAt": null
}
```

`industryEvidence` / `sizeEvidence`: `{ value, source, confidence }` or `null`. `contactedAt`: when the app first invited this person (suppression; never cleared).

### Prospect

```json
{
  "id": 1, "campaignId": 1, "campaignName": "Test campaign", "stage": "pending_approval",
  "score": 8, "cardScore": 7, "scoreReason": "Owns a small manufacturer",
  "stopReason": null, "reviewReason": null, "nextActionAt": null,
  "texts": { "inviteNote": null, "firstMessage": null, "followUp": null },
  "foundAt": "…", "approvedAt": null, "invitedAt": null, "acceptanceObservedAt": null,
  "firstMessageSentAt": null, "followUpSentAt": null, "replyDetectedAt": null, "closedAt": null,
  "person": { …Person }
}
```

- `stage`: `found | scored | rejected | pending_approval | approved | invited | accepted | message_sent | follow_up_sent | completed | withdrawn | stopped | needs_review`.
- `stopReason`: `replied | manual_takeover | null`.
- `texts`: the texts **as sent**, frozen once sent; `null` for a step not sent.

## Routes

### Session (unchanged)

| Method, path | Request | Response |
| --- | --- | --- |
| `GET /api/health` | | `200 { ok, version, dbOk }`, `503` when the database cannot be read |
| `GET /api/session` | | `200 { status, lastCheckedAt, lastError, checking }`; status `unknown | ok | logged_out | checkpoint | restricted | search_capped` |
| `POST /api/session/check` | no body | `200` session; `409 {"error":"A session check is already running"}`; `502 { error, session }` when the check could not run; `400 {"error":"This endpoint takes no body"}` |

### Home

`GET /api/home` → `200`

```json
{
  "session": { "status": "ok", "lastCheckedAt": "…", "lastError": null, "checking": false },
  "safetyStop": null,
  "usage": {
    "invite":         { "used": 0,  "limit": 5,  "open": true,  "resumesAt": null },
    "message":        { "used": 10, "limit": 10, "open": false, "resumesAt": "2026-11-17T08:00:00.000Z" },
    "profile_view":   { "used": 2,  "limit": 40, "open": true,  "resumesAt": null },
    "discovery_page": { "used": 0,  "limit": 10, "open": true,  "resumesAt": null },
    "withdraw":       { "used": 0,  "limit": 10, "open": true,  "resumesAt": null }
  },
  "campaigns": [{ "id": 1, "name": "Test campaign", "status": "running", "discoveryWait": null }],
  "needsYou": { "pendingApproval": 2, "needsReview": 1 }
}
```

- `safetyStop` when one is active: `{ "reason": "checkpoint", "detail": "…" | null, "raisedAt": "…", "whatToDo": "complete LinkedIn's check in the app's window, then press Resume", "invitesBlockedUntil": "…" | null }`. `reason`: `logged_out | checkpoint | restricted | limit_hit | unexpected_pages`.
- `usage`: today's use of each account-wide budget (calendar day in the app's time zone). For invites, `limit` is today's warm-up allowance. `open` is false when the budget is spent (or, for invites, the week's limit is reached or LinkedIn's own limit blocks them); `resumesAt` is then the first working instant it opens again, else `null`. `discovery_page` counts search and recommendation pages; `message` counts first messages and follow-ups.
- `campaigns`: every campaign not archived, newest first. `discoveryWait` says whether discovery for the campaign is waiting, and why; `null` when it is not (always `null` for a draft):
  - `{ "reason": "search_limit", "until": "2026-11-30T23:00:00.000Z", "message": "LinkedIn's monthly search limit; resumes on 2026-12-01" }`: LinkedIn showed its monthly search limit. The limit is on the account, so every search campaign waits until `until` (the first instant of next month in the app's time zone; the date in `message` is that day). Recommendations campaigns do not wait for it.
  - `{ "reason": "no_new_people", "until": "2026-11-16T23:00:00.000Z", "message": "no new people in LinkedIn's suggestions today; looks again tomorrow" }`: a recommendations campaign whose last three loads in a row brought nobody new. LinkedIn's suggestions change, so it is never exhausted: it loads them again from `until`, the start of the next day in the app's time zone.
  - `{ "reason": "exhausted", "until": null, "message": "no more people to find from this source" }`: every source of the campaign has nothing more to show (a search after its last page). Nothing resumes it by itself.
- `needsYou`: prospects in `pending_approval` and in `needs_review`, across campaigns.

### Safety stop

`POST /api/safety-stop/resume`, no body → `200 { "resumed": true }`. `409 {"error":"There is no safety stop to resume"}`. `400 {"error":"This endpoint takes no body"}`.

### Campaigns

| Method, path | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/campaigns` | | `200 { "campaigns": [Campaign] }`, newest first, archived included | |
| `POST /api/campaigns` | Campaign fields (optional body) | `201 { "campaign": Campaign }` with status `draft` | 400 |
| `GET /api/campaigns/:id` | | `200 { "campaign": Campaign }` | 404 |
| `PATCH /api/campaigns/:id` | Campaign fields | `200 { "campaign": Campaign, "notice": null }` for a draft; for a started campaign `notice` is `"Saved. Edits apply only to steps not yet sent; texts already sent stay as they were."` | 400 (field types); 400 `{ "error": "These changes cannot be saved while the campaign is live", "fields": {…} }` (checks before start); 409 `Once a campaign has started only its templates and timings can change. These cannot: name, scoringBrief`, `A completed campaign cannot be edited`, `An archived campaign cannot be edited`; 404 |
| `POST /api/campaigns/:id/start` | optional `{ "confirmAutoApprove": true }` | `200 { "campaign": Campaign }`, status `finding` | 400 `{ "error": "The campaign cannot start yet", "fields": {…} }` (checks before start); 400 `{ "fields": { "confirmAutoApprove": "Send true or false" } }`; 409 `Only a draft can be started; this campaign is <status>`; 404 |
| `POST /api/campaigns/:id/pause` | no body | `200 { "campaign": Campaign }`, status `paused` | 409 `Only a campaign that is finding, awaiting approval or running can be paused; this campaign is <status>`; 400 no body; 404 |
| `POST /api/campaigns/:id/resume` | no body | `200 { "campaign": Campaign }`, back to the status it was paused from; a campaign paused while awaiting approval goes to `running` if prospects were approved during the pause | 409 `Only a paused campaign can be resumed; this campaign is <status>`; 400; 404 |
| `POST /api/campaigns/:id/archive` | no body | `200 { "campaign": Campaign }`, status `archived` (from any status) | 409 `This campaign is already archived`; 400; 404 |
| `POST /api/campaigns/:id/preview` | optional `{ inviteNote?, firstMessage?, followUp?, aiPersonalise? }`: unsaved form values, used instead of the stored ones | `200 { "samples": "prospects" \| "invented", "items": [PreviewItem] }` | 400 (other fields: `Unknown field`); 404 |
| `GET /api/campaigns/:id/prospects` | `?stage=&page=&pageSize=` | `200` Page of Prospect, first found first | 400 `stage`: `Choose one of: found, scored, …`; paging; 404 |

`<status>` reads with spaces: `awaiting approval`.

**PreviewItem**: `{ "prospectId": 3 | null, "fullName": "Test Person 1", "inviteNote": PreviewText | null, "firstMessage": PreviewText, "followUp": PreviewText | null }`. `inviteNote` is `null` when there is no note, `followUp` when there is no follow-up. Items are the campaign's first three prospects (any stage), filled as the engine fills them (only the stored first name). With no prospects yet, one item with `prospectId: null`, `fullName: "Sample person"` and invented values: first_name `Anna`, company `Example Srl`, title `Operations Manager`, location `Milan, Italy`, industry `Manufacturing`.

### Approval queue

| Method, path | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/approvals` | `?campaignId=&minScore=&page=&pageSize=` (both filters optional; `minScore` 0–10, decimals allowed) | `200` Page of ApprovalItem: prospects in `pending_approval`, best score first | 400 `minScore`: `Enter a score from 0 to 10`, `campaignId`: `Enter a campaign id (a whole number)`; 404 unknown campaign |
| `POST /api/prospects/:id/approve` | no body | `200 { "prospect": Prospect }`: stage `approved`, `approvedAt` set. A campaign `awaiting_approval` becomes `running` (a paused one stays paused) | 409 `Only a prospect waiting for approval can be approved; this one is <stage>`; 400; 404 |
| `POST /api/prospects/:id/reject` | no body | `200 { "prospect": Prospect }`: stage `rejected`, `closedAt` set | 409 `Only a prospect waiting for approval can be rejected; this one is <stage>`; 400; 404 |
| `POST /api/approvals/approve-all` | `{ "prospectIds": [12, 15, 19] }`: exactly the prospects the user was shown, 1 to 500 ids, each once | `200 { "approved": 2, "skipped": 1 }`. Each id still in `pending_approval` is approved (`approvedAt` set); any other (unknown, or decided meanwhile) is skipped. Nobody else is approved, even a prospect scored after the list loaded. Each campaign `awaiting_approval` with an approval becomes `running` (a paused one stays paused) | 400 `prospectIds`: `Send the ids of the prospects shown` (missing or not a list), `Send from 1 to 500 prospect ids`, `Send each prospect id once`; `prospectIds.<i>`: `Enter a prospect id (a whole number)`; `campaignId`, `minScore`: `Unknown field` (the old form is refused) |

**ApprovalItem** = Prospect plus `"aiLineEvidence": string | null` (the profile text the AI line rests on, as the AI quoted it; `null` without an AI line), `"preview": { "inviteNote": PreviewText | null, "firstMessage": PreviewText }` for that person, and `"followUpPreview": PreviewText | null`: the follow-up as the engine would write it for that person, `null` when the campaign has no follow-up. Industry and size evidence are on `person.industryEvidence` / `person.sizeEvidence`. With `minScore`, prospects without a score are left out.

### Needs review

| Method, path | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/review` | `?campaignId=&page=&pageSize=` | `200` Page of ReviewItem (Prospect plus `"screenshotPath": string \| null`, the newest screenshot on the prospect's ledger rows, and `"screenshotUrl": string \| null`, where the dashboard loads it, e.g. `"/api/screenshots/2026-11-16T09-00-00-000Z-invite.png"`; `null` without a screenshot), oldest first | 400; 404 unknown campaign |
| `GET /api/screenshots/:name` | | `200` the PNG (`content-type: image/png`, `cache-control: no-store`) from the data directory's `screenshots/` folder. `name` must match `^[A-Za-z0-9._-]+\.png$` and the file, links followed, must be inside that folder | `404 {"error":"No such screenshot"}` for any other name, a missing file, a folder or a link out of the folder; 403 Host check |
| `POST /api/prospects/:id/resolve` | `{ "stage": "accepted", "note": "Checked by hand" }` (`note` optional, ≤ 2000) | `200 { "prospect": Prospect }`. `stage` one of `rejected`, `stopped` (closed: `closedAt` set, `nextActionAt` null) or `approved`, `invited`, `accepted`, `message_sent` (continues: due now, `nextActionAt` = now). `reviewReason` is cleared; the note goes to the activity log | 400 `stage`: `Choose one of: rejected, stopped, approved, invited, accepted, message_sent` (missing or not a stage); 409 `A prospect in needs review cannot move to <stage>. Choose rejected, stopped, approved, invited, accepted or message_sent`; 409 `Only a prospect in needs review can be resolved; this one is <stage>`; 404 |

### Do not contact

`POST /api/people/:id/do-not-contact` with `{ "doNotContact": true }` (or `false` to clear) → `200 { "person": Person }`. 400 `doNotContact`: `Send true or false`; 404 `No person 7`. The flag is on the person, so it holds in every campaign; the engine refuses to invite or message them.

### Activity and ledger

| Method, path | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/activity` | `?campaignId=&level=&page=&pageSize=`; `level` `info | warning | error` | `200` Page of `{ id, at, level, campaignId, prospectId, message }`, newest first | 400 `level`: `Choose one of: info, warning, error`; 404 unknown campaign |
| `GET /api/actions` | `?campaignId=&page=&pageSize=` | `200` Page of `{ id, type, status, campaignId, prospectId, personName, idempotencyKey, attempts, startedAt, finishedAt, error, errorKind, screenshotPath }`, newest first | 400; 404 unknown campaign |

Ledger `type`: `search_page | recommendation_page | profile_view | invite | withdraw | message | thread_check | connections_check | health_check`. `status`: `planned | in_progress | done | failed | unknown`. `personName` is `null` for rows without a prospect.

### Stats

`GET /api/stats` → `200 { "campaigns": [ … ] }`, one entry per campaign, newest first:

```json
{
  "campaignId": 1, "name": "Test campaign", "status": "running",
  "invitesSent": 5, "accepted": 4, "acceptanceRate": 0.8,
  "firstMessagesSent": 2, "replies": 1,
  "replyRate": { "label": "replies seen before the follow-up", "value": 0.5 },
  "medianHoursToAccept": 30, "invitesWithdrawn": 1
}
```

- `acceptanceRate` = accepted ÷ invites sent; `replyRate.value` = replies ÷ first messages sent. Rates are fractions 0–1, `null` when the divisor is 0. Show `replyRate.label` as the rate's label.
- `replies` counts prospects whose reply was seen after their first message was sent and before the follow-up (replies after the follow-up are not tracked; a reply seen before the first message does not count).
- `medianHoursToAccept`: median hours from the invite to the app **observing** the acceptance, `null` with no acceptances.
- `invitesWithdrawn`: prospects in stage `withdrawn`.

### Settings

| Method, path | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/settings` | | `200` all settings (defaults included) | |
| `PATCH /api/settings` | any top-level settings; nested groups (`workingHours`, `actionGapSeconds`, `breaks`, `limits`, `warmUp`, `ai`) one field at a time, e.g. `{ "limits": { "invitesPerDay": 12 } }` | `200` all settings after the change | 400 `{ "error": "Some settings are not valid", "fields": {…} }`; nothing is stored |

Settings keys: `timeZone` (IANA name), `workingDays` (ISO weekdays 1–7, at least one, no repeats), `workingHours { start, end }` (`HH:MM`, end after start), `actionGapSeconds { min, max }`, `breaks { everyActionsMin, everyActionsMax, minutesMin, minutesMax }`, `limits { invitesPerDay, invitesPerWeek, profileViewsPerDay, messagesPerDay, discoveryPagesPerDay, withdrawalsPerDay }`, `warmUp { enabled, invitesStartPerDay, invitesIncreasePerDay }`, `inviteLimitCooldownDays`, `ai { provider: "claude_cli" | "anthropic_api", model }`, `keepAwake` (boolean: keep the Mac awake while a campaign is running or finding inside the working window).

Field messages: `Unknown field`, `Enter a number`, `Enter a whole number`, `Send text`, `Send true or false`, `Send a list`, `Enter N or more`, `Enter N or less`, `Choose at least N`, `Choose one of: …`, and the settings' own: `unknown time zone`, `expected HH:MM, 24-hour`, `end must be after start`, `days must not repeat`, `min must not exceed max`, `everyActionsMin must not exceed everyActionsMax`, `minutesMin must not exceed minutesMax`. Checks across fields (end after start, min ≤ max) run once each field is valid, so they can arrive on a second save.

### Operations

For the Settings screen: backups, auto-start at login, keep-awake and the AI test. Code: `src/server/opsRoutes.ts`; the backups and keep-awake themselves run in `npm start` (`src/worker/operations.ts`).

`GET /api/ops` → `200`

```json
{
  "backups": [{ "file": "app-2026-11-15.db", "date": "2026-11-15", "sizeBytes": 110592 }],
  "service": { "installed": false, "loaded": false, "running": false, "note": "Auto-start is off. To start the app at login, run `npm run service:install` in the app folder." },
  "keepAwake": { "enabled": true, "active": false },
  "dataDir": "/Users/you/Library/Application Support/linkedin-outreach"
}
```

- `backups`: the daily backups in `<dataDir>/backups/`, newest first (at most 7 are kept). `file` is the name `npm run restore -- <file>` takes; `date` is `YYYY-MM-DD` in the Mac's time zone.
- `service`: the launchd job that starts the app at login. `installed`: its plist is in `~/Library/LaunchAgents`; `loaded`: launchd knows it; `running`: it has a process (false when the app runs from a terminal). `note` is a sentence for the user, or `null` when auto-start is installed and loaded: why it cannot be installed from this folder (the app is in `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive, which macOS does not let a login item read), how to turn it on, that it is installed but not loaded, or that its state could not be read.
- `keepAwake`: `enabled` is the `keepAwake` setting; `active` is true while the app holds `caffeinate -i` (a campaign is running or finding, inside the working window, and the engine is on).

`POST /api/ops/backup`, no body → `200`, whatever the outcome:

```json
{ "kind": "created", "file": "app-2026-11-16.db" }
{ "kind": "failed", "message": "The backup failed: the copy failed its integrity check: …" }
```

A fresh backup now, replacing today's once the new copy checks out (a damaged copy never replaces a good one). `kind` is `created | skipped | failed`; `file` comes with `created` and `skipped`, `message` with `failed`. `400 {"error":"This endpoint takes no body"}`. Backups run one at a time; a request during the hourly backup waits for it.

`POST /api/ai/test`, no body → `200`, whatever the outcome:

```json
{ "ok": true, "provider": "claude_cli", "model": "claude-opus-5-5", "elapsedMs": 4210, "message": "The AI answered in 4.2 s: it read \"Marco\" from \"Dott. Marco Rossi 🚀 | Growth\" and scored the two test cards 9 and 1 out of 10." }
{ "ok": false, "provider": "anthropic_api", "model": null, "elapsedMs": 12, "message": "No Anthropic API key. Put {\"anthropicApiKey\": \"sk-ant-...\"} in …/secrets.json, or choose the claude CLI in Settings." }
```

Runs the AI self-test (one name cleaning and one scoring of two invented cards) with the provider and model saved in Settings, so save a change before testing it. It never touches LinkedIn. `provider` is the one tested; `model` is the model that answered, or on failure the model set in Settings (`null` for the provider's default); `elapsedMs` is the whole test. A failure is `ok: false` with a `message` that says what to check. Each AI call may take up to two minutes before it gives up. `409 {"error":"An AI test is already running"}` while one runs; `400 {"error":"This endpoint takes no body"}`.

### Export

`GET /api/export/prospects.csv` (all campaigns) or `?campaignId=3` (one) → `200`, `content-type: text/csv; charset=utf-8`, `content-disposition: attachment; filename="prospects.csv"` (or `"prospects-campaign-3.csv"`). Errors: 400 `campaignId` not a whole number; 404 unknown campaign (JSON).

UTF-8 with a byte-order mark, CRLF line ends, RFC 4180 quoting (a cell with a comma, quote or line break is quoted; quotes doubled). A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` so spreadsheets read it as text. Times are ISO UTC; booleans `true` / `false`; empty for null. Rows: by campaign, then first found first. Columns:

`campaign_id, campaign, prospect_id, stage, score, score_reason, full_name, first_name, headline, title, company, location, profile_url, do_not_contact, found_at, approved_at, invited_at, acceptance_observed_at, first_message_sent_at, follow_up_sent_at, reply_detected_at, closed_at, stop_reason, review_reason, invite_note_sent, first_message_sent, follow_up_sent`
