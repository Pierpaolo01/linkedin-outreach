/**
 * The prospect lifecycle (spec section 5): which stage may follow which. Closed stages allow
 * nothing; every open stage may go to needs review, which the user resolves.
 */
import { CLOSED_STAGES, type ProspectStage } from "../db/schema";

export const TRANSITIONS: Readonly<Record<ProspectStage, readonly ProspectStage[]>> = {
  found: ["scored", "needs_review"],
  scored: ["rejected", "pending_approval", "approved", "needs_review"],
  pending_approval: ["approved", "rejected", "needs_review"],
  approved: ["invited", "rejected", "needs_review"],
  invited: ["accepted", "withdrawn", "needs_review"],
  accepted: ["message_sent", "stopped", "needs_review"],
  // The engine closes the sequence as completed when the follow-up is sent, or at follow-up time
  // when the campaign has none. Replies after the follow-up are not tracked (handoff section 3).
  message_sent: ["follow_up_sent", "completed", "stopped", "needs_review"],
  follow_up_sent: ["completed", "needs_review"],
  needs_review: ["rejected", "stopped", "approved", "invited", "accepted", "message_sent"],
  rejected: [],
  completed: [],
  withdrawn: [],
  stopped: [],
};

export function canMove(from: ProspectStage, to: ProspectStage): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws an Error naming both stages when the move is not allowed. */
export function assertMove(from: ProspectStage, to: ProspectStage): void {
  if (!canMove(from, to)) throw new Error(`A prospect cannot move from ${from} to ${to}`);
}

const closedStages: readonly ProspectStage[] = CLOSED_STAGES;

export function isClosed(stage: ProspectStage): boolean {
  return closedStages.includes(stage);
}
