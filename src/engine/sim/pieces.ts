/**
 * Pieces of work and the runs between breaks, read from the world's log. Shared by the verdicts
 * (assertion 6's "a break within every N pieces of work") and the harness (its burst of kills fires
 * when the current run is long). Kills and restarts do not end a run: only a pause does, and
 * downtime and nights are long pauses.
 */
import type { LogEntry } from "../../linkedin/fake/world";

/**
 * Whether `second` continues the piece of work `first` is part of: a read about a member (or the
 * message box's page load) followed by its send, or by the send's own page load, about the same member.
 */
export function samePiece(first: LogEntry, second: LogEntry): boolean {
  const same = (first.publicId !== undefined && first.publicId === second.publicId) || (first.memberId !== undefined && first.memberId === second.memberId);
  if (!same) return false;
  const lead = first.kind === "profile_view" || first.kind === "thread_read" || (first.kind === "page_load" && first.page === "messaging");
  const send =
    second.kind === "invite" ||
    second.kind === "message" ||
    second.kind === "withdraw" ||
    (second.kind === "page_load" && (second.page === "profile" || second.page === "messaging" || second.page === "sent_invitations"));
  return lead && send;
}

export interface BreakRun {
  /** The first entry of the run's first piece, and the last entry of its last piece. */
  readonly from: LogEntry;
  readonly to: LogEntry;
  readonly pieces: number;
}

/**
 * The runs of pieces of work with no pause of `pauseMs` or more between two of them, oldest first,
 * over the whole log. A pause is any stretch of `pauseMs` or more in which LinkedIn saw nothing:
 * between two pieces, or inside one (a send the laptop slept through, long after its read). A
 * piece with a pause inside it is not a piece "without a break": it ends the run it started in
 * (counted there, once), and the next run starts with the piece after it.
 */
export function breakRuns(log: readonly LogEntry[], pauseMs: number): { readonly runs: BreakRun[]; readonly pieces: number } {
  const runs: BreakRun[] = [];
  let pieces = 0;
  let from: LogEntry | undefined;
  let length = 0;
  let previous: LogEntry | undefined;
  for (const entry of log) {
    const paused = previous !== undefined && entry.at.getTime() - previous.at.getTime() >= pauseMs;
    if (previous !== undefined && samePiece(previous, entry)) {
      if (paused && from !== undefined) runs.push({ from, to: previous, pieces: length });
      if (paused) from = undefined;
      previous = entry;
      continue;
    }
    pieces += 1;
    if (previous === undefined || from === undefined || paused) {
      if (from !== undefined && previous !== undefined) runs.push({ from, to: previous, pieces: length });
      from = entry;
      length = 1;
    } else {
      length += 1;
    }
    previous = entry;
  }
  if (from !== undefined && previous !== undefined) runs.push({ from, to: previous, pieces: length });
  return { runs, pieces };
}

/** Pieces of work in the run still going at `now`: none when the last piece ended `pauseMs` or more ago. */
export function currentRun(log: readonly LogEntry[], pauseMs: number, now: Date): number {
  const last = breakRuns(log, pauseMs).runs.at(-1);
  if (last === undefined || now.getTime() - last.to.at.getTime() >= pauseMs) return 0;
  return last.pieces;
}
