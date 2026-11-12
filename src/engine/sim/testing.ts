/** Shared by the simulation's tests: run a scenario on a throwaway database and judge it. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { people, prospects } from "../../db/schema";
import { judge, type AssertionResult, type Verdict } from "./assertions";
import type { EngineModule, Expectation, Scenario, SimContext, SimRun } from "./harness";
import { runSimulation } from "./harness";
import { enrol, synthetic } from "./scenario";
import type { MemberSpec } from "../../linkedin/fake/world";

export interface Simulated {
  readonly run: SimRun;
  readonly verdict: Verdict;
  result(id: number): AssertionResult;
}

export async function simulate(engine: EngineModule, scenario: Scenario, seed = 1): Promise<Simulated> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-sim-"));
  try {
    const run = await runSimulation({ scenario, engine, dbFile: join(dir, "app.db"), seed });
    const verdict = judge(run);
    return {
      run,
      verdict,
      result(id) {
        const found = verdict.results.find((result) => result.id === id);
        if (found === undefined) throw new Error(`no assertion ${id}`);
        return found;
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function messages(result: AssertionResult): string[] {
  return result.violations.map((violation) => violation.message);
}

export interface AcceptedOptions {
  /** Default "A"; the campaign must exist. */
  readonly campaign?: string;
  /** No first name on the people row, and the full name "Dott. Sample <n>". */
  readonly unnamed?: boolean;
  readonly expect?: Expectation;
}

/** A connection already accepted (in campaign A unless told), with its member id known: due for a first message now. */
export function acceptedConnection(context: SimContext, n: number, extra: Partial<MemberSpec> = {}, options: AcceptedOptions = {}): void {
  const unnamed = options.unnamed === true;
  const member = synthetic(n, {
    degree: 1,
    connectedAt: new Date(context.now.getTime() - 2 * 86_400_000),
    ...(unnamed ? { fullName: `Dott. Sample ${String(n).padStart(3, "0")}` } : {}),
    ...extra,
  });
  const prospectId = enrol(context, {
    campaign: options.campaign ?? "A",
    member: member.spec,
    role: "accepted",
    firstName: unnamed ? null : member.firstName,
    company: member.company,
    ...(options.expect === undefined ? {} : { expect: options.expect, scripted: true }),
  });
  context.db.update(prospects).set({ stage: "accepted", acceptanceObservedAt: context.now, nextActionAt: context.now }).where(eq(prospects.id, prospectId)).run();
  context.db.update(people).set({ memberId: member.spec.memberId }).where(eq(people.publicId, member.spec.publicId)).run();
}
