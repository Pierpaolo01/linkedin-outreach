import { describe, expect, it } from "vitest";
import { budgetNote, campaignsSummary, capitalised, discoveryWaitSentence, failure, formatBytes, formatDate, formatHours, formatStamp, nextActionWhen, plainMessage, POLICY_WORDS, toggleFailure } from "./words";

/** The phrase as the app prints it: its words joined by no-break spaces, so it never breaks across lines. */
const nb = (phrase: string) => phrase.replace(/ /g, "\u00a0");

describe("plainMessage", () => {
  it("puts the session lines in the app's words", () => {
    expect(plainMessage("LinkedIn session: ok")).toBe("Checked LinkedIn: logged in.");
    expect(plainMessage("LinkedIn session: logged_out")).toBe("Checked LinkedIn: logged out.");
    expect(plainMessage("LinkedIn session: checkpoint")).toBe("Checked LinkedIn: it asks for a security check.");
  });

  it("says working window, not working hours", () => {
    expect(plainMessage("Outside working hours: the LinkedIn session is not checked now (last known: ok).")).toBe(
      "Outside the working window: the LinkedIn session is not checked now (last known: logged in).",
    );
  });

  it("leaves every other line's words as they are, without underscores", () => {
    expect(plainMessage("LinkedIn session check failed: Could not open the dedicated window")).toBe(
      "LinkedIn session check failed: Could not open the dedicated window.",
    );
    expect(plainMessage("Test Person 1 needs review: reply_unclear")).toBe("Test Person 1 needs review: reply unclear.");
  });

  it("names an edited campaign's steps as the wizard does, in its order, never its field keys", () => {
    expect(
      plainMessage('Campaign "Hotel owners, Rome" edited: acceptToMessageMinHours, followUpDelayMinHours, aiPersonalise, firstMessage'),
    ).toBe('Campaign “Hotel owners, Rome” edited: Messages, Timings.');
    expect(plainMessage('Campaign "Dentists" edited: name, scoringBrief, sourceUrls')).toBe('Campaign “Dentists” edited: Name, Where people come from, Who fits.');
    expect(plainMessage('Campaign "Dentists" edited: nothing')).toBe('Campaign “Dentists” edited: nothing.');
    // A field the dashboard does not know reads as words, not as a camelCase key.
    expect(plainMessage('Campaign "Dentists" edited: replyCheckEveryHours')).toBe('Campaign “Dentists” edited: reply check every hours.');
  });

  // "the daily budget", never "today's": the line may be from an earlier day.
  it("says a reached daily or weekly limit as a spent budget, without naming the day", () => {
    expect(plainMessage("Discovery paused: the daily limit of 10 discovery pages is reached. It resumes on the next working day.")).toBe(
      "Discovery waits: the daily budget of 10 discovery pages is spent. It resumes on the next working day.",
    );
    expect(plainMessage("Invites wait: the weekly limit of 80 invites is reached.")).toBe("Invites wait: the weekly budget of 80 invites is spent.");
  });

  it("says a campaign that starts running on an approval as a sentence, not a status key", () => {
    expect(plainMessage('Campaign "Local trades, Milan" running: a prospect was approved')).toBe(
      'A prospect was approved in “Local trades, Milan”, so the campaign is running.',
    );
    // The other campaign lines already read as sentences and stay as they are.
    expect(plainMessage('Campaign "Dentists" paused (was awaiting approval)')).toBe('Campaign “Dentists” paused (was awaiting approval).');
    expect(plainMessage('Campaign "Dentists" created as a draft')).toBe('Campaign “Dentists” created as a draft.');
  });
});

describe("plainMessage endings", () => {
  // The lines the app rewrites end with a full stop; the ones it passes through must too, so the log reads as one voice.
  it("ends every line with exactly one full stop, unless it already ends a sentence", () => {
    expect(plainMessage("Sent an invite to Test Person 10")).toBe("Sent an invite to Test Person 10.");
    expect(plainMessage("Withdrew the invite to Test Person 12 after 21 days")).toBe("Withdrew the invite to Test Person 12 after 21 days.");
    expect(plainMessage("Test Person 6 needs review: tried 3 times without a clear result")).toBe("Test Person 6 needs review: tried 3 times without a clear result.");
    expect(plainMessage("Safety stop: LinkedIn showed a checkpoint.")).toBe("Safety stop: LinkedIn showed a checkpoint.");
    expect(plainMessage("Is the window open?")).toBe("Is the window open?");
    expect(plainMessage("Stopped!")).toBe("Stopped!");
    expect(plainMessage("Waiting…")).toBe("Waiting…");
    expect(plainMessage("Done..")).toBe("Done.");
    expect(plainMessage("Checked these:")).toBe("Checked these.");
    expect(plainMessage("Discovery waits: the daily limit of 10 discovery pages is reached")).toBe("Discovery waits: the daily budget of 10 discovery pages is spent.");
  });
});

describe("plainMessage beside a campaign column", () => {
  // The activity log prints each line's campaign in its own column, so the line does not name it again.
  it("drops the campaign's name when the row already shows it", () => {
    const shown = (text: string, campaign: string) => plainMessage(text, { campaign, campaignShown: true });
    expect(shown('Campaign "Strip shot campaign" edited: acceptToMessageMinHours', "Strip shot campaign")).toBe("Edited: Timings.");
    expect(shown("Campaign Restaurants, Naples paused by you", "Restaurants, Naples")).toBe("Paused by you.");
    expect(shown('Campaign "Dentists" created as a draft', "Dentists")).toBe("Created as a draft.");
    expect(shown('Campaign "Dentists" paused (was awaiting approval)', "Dentists")).toBe("Paused (was awaiting approval).");
    expect(shown('Campaign "Local trades, Milan" running: a prospect was approved', "Local trades, Milan")).toBe(
      "A prospect was approved, so the campaign is running.",
    );
    expect(shown("Discovery for Architects, Turin: 3 new prospects from 30 cards (recommendations)", "Architects, Turin")).toBe(
      "Discovery: 3 new prospects from 30 cards (recommendations).",
    );
    expect(shown("Architects, Turin completed: nobody matched the campaign; there is nothing more to find", "Architects, Turin")).toBe(
      "Completed: nobody matched the campaign; there is nothing more to find.",
    );
    // A line that does not lead with the campaign keeps its words.
    expect(shown("Sent the first message to Test Person 16", "Hotel owners, Rome")).toBe("Sent the first message to Test Person 16.");
  });

  // Where the row shows no campaign (Home), the name stays, always in quotes.
  it("keeps the name in quotes where the row shows no campaign", () => {
    const alone = (text: string, campaign: string | undefined) => plainMessage(text, { campaign, campaignShown: false });
    expect(alone("Campaign Restaurants, Naples paused by you", "Restaurants, Naples")).toBe('Campaign “Restaurants, Naples” paused by you.');
    expect(alone('Campaign "Dentists" edited: name', "Dentists")).toBe('Campaign “Dentists” edited: Name.');
    expect(alone('Campaign "Dentists" edited: name', undefined)).toBe('Campaign “Dentists” edited: Name.');
    expect(alone("Discovery for Architects, Turin: 3 new prospects from 30 cards", "Architects, Turin")).toBe(
      'Discovery for “Architects, Turin”: 3 new prospects from 30 cards.',
    );
    expect(alone("Architects, Turin completed: nobody matched", "Architects, Turin")).toBe('“Architects, Turin” completed: nobody matched.');
  });
});

describe("discoveryWaitSentence", () => {
  const until = "2026-11-30T23:00:00.000Z";
  const say = (wait: Parameters<typeof discoveryWaitSentence>[0]["wait"], safetyStop: boolean) => discoveryWaitSentence({ wait, timeZone: "Europe/Rome", safetyStop });

  it("says when finding people resumes, and that the search limit resets, as a budget does", () => {
    expect(say({ reason: "search_limit", until, message: "" }, false)).toBe(
      `Finding people is waiting: LinkedIn’s monthly search limit is reached. It resets on ${nb("1 December 2026")}.`,
    );
    expect(say({ reason: "no_new_people", until: null, message: "" }, false)).toBe(
      "Finding people is waiting: LinkedIn’s recommendations show nobody new today. The app looks again tomorrow.",
    );
  });

  // During a safety stop nothing resumes until the user does: only what stays true either way.
  it("promises no time and no work during a safety stop", () => {
    const lines = [
      say({ reason: "search_limit", until, message: "" }, true),
      say({ reason: "no_new_people", until: null, message: "" }, true),
      say({ reason: "unreadable", until, message: "" }, true),
      say({ reason: "exhausted", until: null, message: "" }, true),
    ];
    expect(lines).toEqual([
      `LinkedIn’s monthly search limit is reached. It resets on ${nb("1 December 2026")}.`,
      "LinkedIn’s recommendations showed nobody new today.",
      "The app could not read LinkedIn’s page; the activity log has the details.",
      "Finding people has stopped: there is nobody more to find from this campaign’s sources.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/resumes|again|tomorrow|waiting/);
  });
});

describe("nextActionWhen", () => {
  const now = new Date("2026-11-12T09:00:00Z");
  const base = { timeZone: "Europe/Rome", now, stage: "invited" } as const;

  // A value in the People table's column: a capital, like the column's other values, and a time that never breaks.
  it("says when the next step is planned, or that it is due, as a column value", () => {
    expect(nextActionWhen({ ...base, at: "2026-11-12T12:30:00Z", safetyStop: false })).toBe(nb("Today at 13:30"));
    expect(nextActionWhen({ ...base, at: "2026-11-13T12:30:00Z", safetyStop: false })).toBe(nb("Tomorrow at 13:30"));
    expect(nextActionWhen({ ...base, at: "2026-11-15T12:30:00Z", safetyStop: false })).toBe(nb("On 15 Nov at 13:30"));
    expect(nextActionWhen({ ...base, at: "2026-11-12T08:00:00Z", safetyStop: false })).toBe("Due now");
  });

  // During a safety stop no step is sent at its time: it waits for the user's resume.
  it("says after you resume during a safety stop, never a time", () => {
    expect(nextActionWhen({ ...base, at: "2026-11-12T12:30:00Z", safetyStop: true })).toBe("After you resume");
    expect(nextActionWhen({ ...base, at: "2026-11-12T08:00:00Z", safetyStop: true })).toBe("After you resume");
  });

  // A person waiting for the user's own decision is not held by the stop: the app has nothing planned for them either way.
  it("plans nothing during a safety stop for a person who waits on the user, and keeps After you resume for the app's own steps", () => {
    for (const stage of ["pending_approval", "needs_review"] as const) {
      expect(nextActionWhen({ ...base, stage, at: "2026-11-12T12:30:00Z", safetyStop: true }), stage).toBeUndefined();
    }
    for (const stage of ["approved", "invited", "accepted", "message_sent"] as const) {
      expect(nextActionWhen({ ...base, stage, at: "2026-11-12T12:30:00Z", safetyStop: true }), stage).toBe("After you resume");
    }
  });
});

describe("dates, times and counts", () => {
  // A date, a time or a count with its unit is one phrase: it never breaks across lines.
  it("joins the words of a date, a stamp, hours, days and sizes with no-break spaces", () => {
    expect(formatDate("2026-11-30T23:00:00.000Z", "Europe/Rome")).toBe(nb("1 December 2026"));
    expect(formatStamp("2026-11-12T09:42:00Z", "Europe/Rome")).toBe(nb("12 Nov 10:42"));
    expect(formatHours(30)).toBe(nb("30 hours"));
    expect(formatHours(1)).toBe(nb("1 hour"));
    expect(formatHours(60)).toBe(nb("2.5 days"));
    expect(formatBytes(2.4 * 1024 * 1024)).toBe(nb("2.4 MB"));
  });
});

describe("capitalised", () => {
  it("starts a value with a capital, as its sibling values do, and leaves the rest as it is", () => {
    expect(capitalised(POLICY_WORDS.calendar)).toBe("Every day counts");
    expect(capitalised(POLICY_WORDS.working_days)).toBe("Only working days count");
    expect(capitalised("{{first_name}} is not set")).toBe("{{first_name}} is not set");
    expect(capitalised("")).toBe("");
  });
});

describe("budgetNote", () => {
  // Thursday 12 November 2026, 10:00 in Rome; the budget opens again on Monday 16 November at 09:00.
  const now = new Date("2026-11-12T09:00:00Z");
  const spent = { used: 10, limit: 10, open: false, resumesAt: "2026-11-16T08:00:00.000Z" };
  const base = { kind: "discovery_page", timeZone: "Europe/Rome", now, warmUpTarget: undefined } as const;

  // One form in every state: when the budget resets is true with or without a safety stop, and promises no work.
  it("says when a spent budget resets, in one form", () => {
    expect(budgetNote({ ...base, budget: spent })).toBe(`Budget spent; it resets ${nb("Monday 09:00")}`);
    expect(budgetNote({ ...base, budget: { ...spent, resumesAt: "2026-11-13T08:00:00.000Z" } })).toBe(`Budget spent; it resets ${nb("tomorrow 09:00")}`);
    expect(budgetNote({ ...base, budget: { ...spent, resumesAt: null } })).toBe("Budget spent");
    expect(budgetNote({ ...base, budget: spent })).not.toMatch(/resumes/);
  });

  it("says a warm-up allowance, and nothing for an open budget", () => {
    const open = { used: 2, limit: 5, open: true, resumesAt: null };
    expect(budgetNote({ ...base, kind: "invite", budget: open, warmUpTarget: 20 })).toBe(`Warm-up: today’s allowance, rising to ${nb("20 a day")}`);
    expect(budgetNote({ ...base, kind: "invite", budget: open })).toBeUndefined();
    expect(budgetNote({ ...base, budget: open, warmUpTarget: 20 })).toBeUndefined();
  });
});

describe("failure", () => {
  // What failed, what state things are in and what to do are the app's words; what the server said is set apart.
  it("keeps the app's words and sets the server's apart, ending as a sentence", () => {
    expect(failure("The draft was not saved.", { message: "test: the app could not save", status: 500 })).toEqual({
      text: "The draft was not saved.",
      detail: "What the app said: test: the app could not save.",
    });
    expect(failure("The backup did not run.", "disk full")).toEqual({ text: "The backup did not run.", detail: "What the app said: disk full." });
    expect(failure("The draft was not saved.", { message: "  ", status: 500 })).toEqual({ text: "The draft was not saved.", detail: undefined });
    expect(failure("The draft was not saved.")).toEqual({ text: "The draft was not saved.", detail: undefined });
  });

  // When the app did not answer, the sentence is the dashboard's own: it is not "what the app said".
  it("says the dashboard's own sentence without the app's label when the app did not answer", () => {
    expect(failure("The draft was not saved.", { message: "Cannot reach the app. Is it still running?", status: 0 }).detail).toBe(
      "Cannot reach the app. Is it still running?",
    );
  });

  it("says a failed Pause or Resume, the campaign's state and what to press", () => {
    expect(toggleFailure({ name: "Dentists", resuming: false, said: { message: "busy", status: 409 } })).toEqual({
      text: 'Campaign “Dentists” was not paused. Nothing changed; press Pause again.',
      detail: "What the app said: busy.",
    });
    expect(toggleFailure({ name: undefined, resuming: true, said: { message: "busy", status: 409 } }).text).toBe(
      "The campaign was not resumed. It is still paused; press Resume again.",
    );
  });
});

describe("campaignsSummary", () => {
  it("counts every campaign at work as active, in the words the table does not contradict", () => {
    expect(campaignsSummary(["running", "awaiting_approval", "finding", "paused", "draft"], false)).toBe(`${nb("5 campaigns")}, 3 active`);
    expect(campaignsSummary(["paused"], false)).toBe(`${nb("1 campaign")}, 0 active`);
  });

  // During a safety stop the red banner right above already says everything is stopped, and the table says which:
  // the header does not say it a third time, and no campaign is active.
  it("says only how many campaigns there are during a safety stop", () => {
    expect(campaignsSummary(["running", "awaiting_approval", "finding", "paused", "draft"], true)).toBe(nb("5 campaigns"));
    expect(campaignsSummary(["paused", "draft"], true)).toBe(nb("2 campaigns"));
  });
});
