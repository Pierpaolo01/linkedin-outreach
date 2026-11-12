import { describe, expect, it } from "vitest";
import { SESSION_STATUSES, type Session } from "../apiSchemas";
import { sessionView } from "./sessionView";

const session = (status: Session["status"], lastCheckedAt: string | null): Session => ({ status, lastCheckedAt, lastError: null, checking: false });

describe("sessionView", () => {
  it("says the window's state during a safety stop as a full sentence about the dedicated window", () => {
    expect(sessionView(session("ok", "2026-11-13T09:00:00.000Z")).window).toBe("The dedicated window is still logged in");
    for (const status of SESSION_STATUSES) {
      for (const lastCheckedAt of [null, "2026-11-13T09:00:00.000Z"]) {
        const { window } = sessionView(session(status, lastCheckedAt));
        expect(window, status).toMatch(/^The dedicated window /);
        expect(window, status).not.toMatch(/[.!]$/);
      }
    }
  });
});
