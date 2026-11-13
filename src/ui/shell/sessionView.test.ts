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

  // The light agrees with the banner: every state that raises the red "LinkedIn needs you" bar has the red dot; a
  // state that is not working but needs nothing from the user is the hollow ring a campaign that is not working has.
  it("lights red whenever the red banner shows, a hollow ring for a quiet state, and the green dot when logged in", () => {
    for (const status of SESSION_STATUSES) {
      for (const lastCheckedAt of [null, "2026-11-13T09:00:00.000Z"]) {
        const view = sessionView(session(status, lastCheckedAt));
        if (view.problem !== undefined) expect(view.light, `${status} ${lastCheckedAt ?? "never"}`).toBe("status-error");
        else if (status === "ok") expect(view.light).toBe("status-success");
        else expect(view.light, `${status} ${lastCheckedAt ?? "never"}`).toBe("status-neutral status-hollow");
      }
    }
    expect(sessionView(session("logged_out", "2026-11-13T09:00:00.000Z")).light).toBe("status-error");
    expect(sessionView(session("unknown", "2026-11-13T09:00:00.000Z")).light).toBe("status-error");
    expect(sessionView(session("unknown", null)).light).toBe("status-neutral status-hollow");
    expect(sessionView(session("search_capped", "2026-11-13T09:00:00.000Z")).light).toBe("status-neutral status-hollow");
  });
});
