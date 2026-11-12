import { describe, expect, it } from "vitest";
import { plainMessage } from "./words";

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

  it("leaves every other line as it is, without underscores", () => {
    expect(plainMessage("LinkedIn session check failed: Could not open the dedicated window")).toBe(
      "LinkedIn session check failed: Could not open the dedicated window",
    );
    expect(plainMessage("Test Person 1 needs review: reply_unclear")).toBe("Test Person 1 needs review: reply unclear");
  });

  it("names an edited campaign's steps as the wizard does, in its order, never its field keys", () => {
    expect(
      plainMessage('Campaign "Hotel owners, Rome" edited: acceptToMessageMinHours, followUpDelayMinHours, aiPersonalise, firstMessage'),
    ).toBe('Campaign "Hotel owners, Rome" edited: Messages, Timings.');
    expect(plainMessage('Campaign "Dentists" edited: name, scoringBrief, sourceUrls')).toBe('Campaign "Dentists" edited: Name, Where people come from, Who fits.');
    expect(plainMessage('Campaign "Dentists" edited: nothing')).toBe('Campaign "Dentists" edited: nothing.');
    // A field the dashboard does not know reads as words, not as a camelCase key.
    expect(plainMessage('Campaign "Dentists" edited: replyCheckEveryHours')).toBe('Campaign "Dentists" edited: reply check every hours.');
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
      'A prospect was approved in "Local trades, Milan", so the campaign is running.',
    );
    // The other campaign lines already read as sentences and stay as they are.
    expect(plainMessage('Campaign "Dentists" paused (was awaiting approval)')).toBe('Campaign "Dentists" paused (was awaiting approval)');
    expect(plainMessage('Campaign "Dentists" created as a draft')).toBe('Campaign "Dentists" created as a draft');
  });
});
