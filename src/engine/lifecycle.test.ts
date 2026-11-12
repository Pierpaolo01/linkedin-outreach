import { describe, expect, it } from "vitest";
import { PROSPECT_STAGES, type ProspectStage } from "../db/schema";
import { assertMove, canMove, isClosed } from "./lifecycle";

/** Every allowed move, written out from spec section 5 and decisions 27–29. Every other pair is refused. */
const ALLOWED: readonly (readonly [ProspectStage, ProspectStage])[] = [
  ["found", "scored"],
  ["found", "needs_review"],
  ["scored", "rejected"],
  ["scored", "pending_approval"],
  ["scored", "approved"],
  ["scored", "needs_review"],
  ["pending_approval", "approved"],
  ["pending_approval", "rejected"],
  ["pending_approval", "needs_review"],
  ["approved", "invited"],
  ["approved", "rejected"],
  ["approved", "needs_review"],
  ["invited", "accepted"],
  ["invited", "withdrawn"],
  ["invited", "needs_review"],
  ["accepted", "message_sent"],
  ["accepted", "stopped"],
  ["accepted", "needs_review"],
  ["message_sent", "follow_up_sent"],
  ["message_sent", "completed"],
  ["message_sent", "stopped"],
  ["message_sent", "needs_review"],
  ["follow_up_sent", "completed"],
  ["follow_up_sent", "needs_review"],
  ["needs_review", "rejected"],
  ["needs_review", "stopped"],
  ["needs_review", "approved"],
  ["needs_review", "invited"],
  ["needs_review", "accepted"],
  ["needs_review", "message_sent"],
];

const allowed = new Set(ALLOWED.map(([from, to]) => `${from} -> ${to}`));
const everyPair = PROSPECT_STAGES.flatMap((from) => PROSPECT_STAGES.map((to) => [from, to] as const));

describe("canMove", () => {
  it.each(everyPair)("%s -> %s matches the expected table", (from, to) => {
    expect(canMove(from, to)).toBe(allowed.has(`${from} -> ${to}`));
  });

  it("lets no stage move to itself", () => {
    for (const stage of PROSPECT_STAGES) expect(canMove(stage, stage)).toBe(false);
  });

  it("lets no closed stage move anywhere", () => {
    for (const from of ["rejected", "completed", "withdrawn", "stopped"] as const) {
      for (const to of PROSPECT_STAGES) expect(canMove(from, to)).toBe(false);
    }
  });
});

describe("assertMove", () => {
  it("passes an allowed move", () => {
    expect(() => assertMove("accepted", "message_sent")).not.toThrow();
  });

  it("throws naming both stages for a refused move", () => {
    expect(() => assertMove("stopped", "message_sent")).toThrow(/stopped.*message_sent/);
    expect(() => assertMove("follow_up_sent", "message_sent")).toThrow(Error);
  });
});

describe("isClosed", () => {
  it.each(PROSPECT_STAGES)("%s", (stage) => {
    expect(isClosed(stage)).toBe(["rejected", "completed", "withdrawn", "stopped"].includes(stage));
  });
});
