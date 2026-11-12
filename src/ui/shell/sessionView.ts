import type { SafetyStop, Session } from "../apiSchemas";

/** How each LinkedIn session state and safety stop reads on screen. */

export interface SessionView {
  readonly label: string;
  /** The window's state as a full sentence (without its full stop), for the red session card during a safety stop. */
  readonly window: string;
  /** daisyUI status colour for the light. */
  readonly light: "status-success" | "status-warning" | "status-error" | "status-neutral";
  /** When the session needs the user: what to do, shown in a red banner. */
  readonly problem?: string;
}

const VIEWS: Readonly<Record<Session["status"], SessionView>> = {
  ok: { label: "Logged in", window: "The dedicated window is still logged in", light: "status-success" },
  logged_out: {
    label: "Logged out",
    window: "The dedicated window is logged out",
    light: "status-warning",
    problem: "Log in to LinkedIn in the dedicated window, then press Re-check.",
  },
  checkpoint: {
    label: "Checkpoint",
    window: "The dedicated window shows a security check",
    light: "status-error",
    problem: "LinkedIn is asking for a security check in the dedicated window. Complete it there yourself, then press Re-check.",
  },
  restricted: {
    label: "Restricted",
    window: "The dedicated window shows a restriction or warning",
    light: "status-error",
    problem:
      "LinkedIn shows a restriction or warning on the account. Read it in the dedicated window and do not try to get past it. Press Re-check once LinkedIn has lifted it.",
  },
  search_capped: { label: "Search limit reached", window: "The dedicated window is still logged in, and LinkedIn's search limit is reached", light: "status-neutral" },
  unknown: { label: "Not checked yet", window: "The dedicated window has not been checked yet", light: "status-neutral" },
};

export function sessionView(session: Session): SessionView {
  if (session.status === "unknown" && session.lastCheckedAt !== null) {
    return {
      label: "Unknown",
      window: "The dedicated window could not be checked",
      light: "status-neutral",
      problem: "The last check could not tell whether LinkedIn is logged in. Make sure the dedicated window shows LinkedIn, then press Re-check.",
    };
  }
  return VIEWS[session.status];
}

/** What LinkedIn showed, in a sentence, for each safety stop. */
export const STOP_REASON: Readonly<Record<SafetyStop["reason"], { readonly short: string; readonly sentence: string }>> = {
  logged_out: { short: "Logged out", sentence: "LinkedIn logged the app out." },
  checkpoint: { short: "Security check", sentence: "LinkedIn is asking for a security check." },
  restricted: { short: "Account warning", sentence: "LinkedIn shows a restriction or warning on the account." },
  limit_hit: { short: "Invitation limit", sentence: "LinkedIn says the account has reached its invitation limit." },
  unexpected_pages: { short: "Pages not recognised", sentence: "Three LinkedIn pages in a row looked different from what the app expects." },
};
