import type { SafetyStop, Session } from "../apiSchemas";

/** How each LinkedIn session state and safety stop reads on screen. */

export interface SessionView {
  readonly label: string;
  /** daisyUI status colour for the light. */
  readonly light: "status-success" | "status-warning" | "status-error" | "status-neutral";
  /** When the session needs the user: what to do, shown in a red banner. */
  readonly problem?: string;
}

const VIEWS: Readonly<Record<Session["status"], SessionView>> = {
  ok: { label: "Connected", light: "status-success" },
  logged_out: {
    label: "Logged out",
    light: "status-warning",
    problem: "Log in to LinkedIn in the dedicated window, then press Re-check.",
  },
  checkpoint: {
    label: "Checkpoint",
    light: "status-error",
    problem: "LinkedIn is asking for a security check in the dedicated window. Complete it there yourself, then press Re-check.",
  },
  restricted: {
    label: "Restricted",
    light: "status-error",
    problem:
      "LinkedIn shows a restriction or warning on the account. Read it in the dedicated window and do not try to get past it. Press Re-check once LinkedIn has lifted it.",
  },
  search_capped: { label: "Search limit reached", light: "status-warning" },
  unknown: { label: "Not checked yet", light: "status-neutral" },
};

export function sessionView(session: Session): SessionView {
  if (session.status === "unknown" && session.lastCheckedAt !== null) {
    return {
      label: "Unknown",
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
