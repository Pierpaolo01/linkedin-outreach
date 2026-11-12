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
});
