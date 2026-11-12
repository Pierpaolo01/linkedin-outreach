/** Runs seeds of the three-week scenario and prints a readable report of the verdicts. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXTRA_COUNT_KEYS, judge, NORMAL_DAY_NOTE, violationCount, type AssertionResult, type Verdict } from "./assertions";
import { MINIMUM_KEYS, runSimulation, type EngineModule } from "./harness";
import { threeWeekScenario } from "./scenario";

export async function runSeed(engine: EngineModule, seed: number): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-sim-"));
  try {
    const run = await runSimulation({ scenario: threeWeekScenario(seed), engine, dbFile: join(dir, "app.db"), seed });
    return judge(run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- a verdict from a child process

const checkedSchema = z.object({ count: z.number(), what: z.string() });
const verdictSchema = z.object({
  seed: z.number(),
  results: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      violations: z.array(z.object({ message: z.string(), detail: z.record(z.string(), z.unknown()).optional() })),
      notes: z.array(z.string()),
      checked: z.array(checkedSchema),
    }),
  ),
  counts: z.record(z.enum([...MINIMUM_KEYS, ...EXTRA_COUNT_KEYS]), z.number()),
  daysAfterDowntime: z.array(
    z.object({
      day: z.string(),
      invites: z.number(),
      allowance: z.number(),
      messages: z.number(),
      profileViews: z.number(),
      withdrawals: z.number(),
      discoveryPages: z.number(),
      downtime: z.string(),
      messageLimit: z.number(),
      full: z.boolean(),
      atLimit: z.boolean(),
    }),
  ),
  wallMs: z.number(),
});

/** A verdict printed as JSON by `scripts/simulate.ts --json`, checked field by field. */
export function parseVerdict(json: string): Verdict {
  const parsed: unknown = JSON.parse(json);
  return verdictSchema.parse(parsed);
}

// ---------------------------------------------------------------- the detailed report

const MAX_SHOWN = 12;

function detail(value: unknown): string {
  return value === undefined ? "" : ` ${JSON.stringify(value)}`;
}

/** A violation's message with its ids, times and numbers taken out, to count violations by kind. */
function kindOf(message: string): string {
  return message
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
    .replace(/sim-member-\d+(-old)?/g, "<member>")
    .replace(/\b([a-z0-9_]+):\d+/g, "$1:<id>")
    .replace(/\d+(\.\d+)?/g, "N");
}

function resultOf(verdict: Verdict, id: number): AssertionResult | undefined {
  return verdict.results.find((result) => result.id === id);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function table(rows: readonly (readonly string[])[], align: "left" | "right" = "right"): string[] {
  const widths = (rows[0] ?? []).map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  return rows.map((row) =>
    `  ${row.map((cell, index) => (align === "left" || index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0))).join("  ")}`.trimEnd(),
  );
}

/** Per assertion: ok, or each violation with its seed; the counts per seed; then the summary. */
export function formatReport(verdicts: readonly Verdict[]): string {
  const lines: string[] = [];
  const first = verdicts[0];
  if (first === undefined) return "no seeds run";
  lines.push(`Engine simulation: ${verdicts.length} seed(s) of the three-week scenario (${verdicts.map((verdict) => verdict.seed).join(", ")})`, "");
  for (const template of first.results) {
    const all = verdicts.flatMap((verdict) => (resultOf(verdict, template.id)?.violations ?? []).map((violation) => ({ seed: verdict.seed, violation })));
    lines.push(`${template.id}. ${template.title}: ${all.length === 0 ? "ok" : `${all.length} violation(s)`}`);
    for (const { seed, violation } of all.slice(0, MAX_SHOWN)) lines.push(`   seed ${seed}: ${violation.message}${detail(violation.detail)}`);
    if (all.length > MAX_SHOWN) lines.push(`   ... and ${all.length - MAX_SHOWN} more`);
    if (all.length > 0) {
      const kinds = new Map<string, Set<number>>();
      const counts = new Map<string, number>();
      for (const { seed, violation } of all) {
        const kind = kindOf(violation.message);
        kinds.set(kind, (kinds.get(kind) ?? new Set()).add(seed));
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      lines.push("   by kind:");
      for (const [kind, seeds] of [...kinds].sort((a, b) => (counts.get(b[0]) ?? 0) - (counts.get(a[0]) ?? 0))) {
        lines.push(`     ${counts.get(kind) ?? 0} x ${kind}  (in ${seeds.size} of ${verdicts.length} seeds)`);
      }
    }
  }
  lines.push("", "Counts per seed (assertion 7):");
  const columns: [string, (verdict: Verdict) => string | number][] = [
    ["seed", (v) => v.seed],
    ["invites", (v) => v.counts.invites],
    ["accepted", (v) => v.counts.acceptancesObserved],
    ["1st msg", (v) => v.counts.firstMessages],
    ["follow-up", (v) => v.counts.followUps],
    ["withdrawn", (v) => v.counts.withdrawals],
    ["stop reply", (v) => v.counts.stoppedReplied],
    ["stop manual", (v) => v.counts.stoppedManual],
    ["review", (v) => v.counts.needsReview],
    ["kills b/t/a/btw", (v) => `${v.counts.killsBefore}/${v.counts.killsTyped}/${v.counts.killsAfter}/${v.counts.killsBetween}`],
    ["recon-read", (v) => v.counts.killsDuringReconcileRead],
    ["re-kill", (v) => v.counts.killsBeforeTickCompleted],
    ["reconcile sent/retried/held/not", (v) => `${v.counts.reconcileConfirmedSent}/${v.counts.reconcileRetried}/${v.counts.reconcileHeld}/${v.counts.reconcileNotRetried}`],
    ["stops cp/limit/other", (v) => `${v.counts.safetyStopCheckpoint}/${v.counts.safetyStopLimit}/${v.counts.safetyStopOther}`],
    ["mid-send reply", (v) => v.counts.repliesMidSend],
    ["slept reads p/r", (v) => `${v.counts.suspendedReadsPlanned}/${v.counts.suspendedReadsRandom}`],
    ["slept sends p/r", (v) => `${v.counts.suspendedSendsPlanned}/${v.counts.suspendedSendsRandom}`],
    ["mid-tick", (v) => v.counts.changesMidTick],
    ["mid-read settings", (v) => v.counts.settingsChangedMidRead],
    ["kills reply/manual", (v) => v.counts.killsOnReplyAndTakeover],
    ["burst", (v) => v.counts.killsInBurst],
    ["wk-limit weeks", (v) => v.counts.weeksStoppedByWeeklyLimit],
    ["full day at limit", (v) => v.counts.fullDaysAfterDowntimeAtLimit],
    ["no-break run", (v) => v.counts.longestRunWithoutBreak],
    ["discovered", (v) => v.counts.peopleDiscovered],
    ["cards", (v) => v.counts.cardsScored],
    ["opened", (v) => v.counts.profilesOpenedForScoring],
    ["days view/page limit", (v) => `${v.counts.daysAtProfileViewLimit}/${v.counts.daysAtDiscoveryLimit}`],
    ["search caps", (v) => v.counts.searchCaps],
    ["disc. invited", (v) => v.counts.discoveredInvited],
    ["AI night/stop", (v) => `${v.counts.aiCallsAtNight}/${v.counts.aiCallsDuringSafetyStop}`],
    ["errors", (v) => v.counts.engineErrors],
    ["ticks", (v) => v.counts.ticks],
    ["run", (v) => seconds(v.wallMs)],
  ];
  lines.push(...table([columns.map(([name]) => name), ...verdicts.map((verdict) => columns.map(([, get]) => String(get(verdict))))]));
  lines.push("", ...formatSummary(verdicts));
  return lines.join("\n");
}

// ---------------------------------------------------------------- the summary, for the milestone report

/** The handoff's assertions (section 5, item 2) in its words, then the simulation's own checks. */
const HANDOFF_LINES: readonly (readonly [number, string])[] = [
  [1, "No step sent twice to the same person"],
  [2, "No limit exceeded in any day or week"],
  [3, "Nothing sent outside working hours"],
  [4, "Nothing sent after a reply or after the user wrote himself"],
  [5, "Nobody contacted in a second campaign"],
  [6, "After downtime the next day is a normal day, not a backlog"],
];
const OWN_LINES: readonly (readonly [number, string])[] = [
  [0, "Every simulated crash really stopped the app"],
  [7, "Every path ran, and nothing was left stuck"],
  [8, "The app's records match what LinkedIn received"],
  [9, "Discovery and scoring kept to thresholds, exclusions, the waiting line and the search cap"],
  [10, "AI work loaded no LinkedIn page, at night and during a safety stop"],
];

const number = (value: number): string => value.toLocaleString("en-US");

function checkedAcross(verdicts: readonly Verdict[], id: number): string {
  const totals = new Map<string, number>();
  for (const verdict of verdicts) {
    for (const checked of resultOf(verdict, id)?.checked ?? []) totals.set(checked.what, (totals.get(checked.what) ?? 0) + checked.count);
  }
  return [...totals].map(([what, count]) => `${number(count)} ${what}`).join(", ");
}

function range(values: readonly number[]): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? number(low) : `${number(low)}–${number(high)}`;
}

function weekday(day: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T12:00:00Z`).getUTCDay()] ?? "";
}

/** One line per assertion with ok or its violations and what it checked, then the totals. */
export function formatSummary(verdicts: readonly Verdict[]): string[] {
  const lines: string[] = [];
  const seeds = verdicts.length;
  const row = ([id, label]: readonly [number, string]): string[] => {
    const violations = verdicts.reduce((sum, verdict) => sum + (resultOf(verdict, id)?.violations.length ?? 0), 0);
    return [label, violations === 0 ? "ok" : `${number(violations)} violation${violations === 1 ? "" : "s"}`, checkedAcross(verdicts, id)];
  };
  lines.push(`Summary: ${seeds} simulated three-week runs, each with crashes, faults, downtime and safety stops`, "");
  lines.push(...table([["Assertion", "Result", `Checked, across all ${seeds} runs`], ...HANDOFF_LINES.map(row)], "left"));
  const normalDay = verdicts[0]?.results.find((result) => result.id === 6)?.notes.find((note) => note.startsWith(NORMAL_DAY_NOTE));
  if (normalDay !== undefined) lines.push(`  ("${HANDOFF_LINES[5]?.[1] ?? "normal day"}": ${normalDay})`);
  lines.push("", ...table([["The simulation's own checks", "Result", "Checked"], ...OWN_LINES.map(row)], "left"));

  const sum = (get: (verdict: Verdict) => number): number => verdicts.reduce((total, verdict) => total + get(verdict), 0);
  const c = (key: keyof Verdict["counts"]): number => sum((verdict) => verdict.counts[key]);
  lines.push("", `Totals across ${seeds} runs`);
  lines.push(
    ...table(
      [
        ["Invites", number(c("invites"))],
        ["First messages", number(c("firstMessages"))],
        ["Follow-ups", number(c("followUps"))],
        ["Withdrawals", number(c("withdrawals"))],
        ["Acceptances seen", number(c("acceptancesObserved"))],
        ["Sequences stopped", `${number(c("stoppedReplied"))} on a reply, ${number(c("stoppedManual"))} because the user wrote himself`],
        ["Held for review", number(c("needsReview"))],
        [
          "Crashes (kills)",
          `${number(c("killsBefore"))} before an action, ${number(c("killsTyped"))} with a message typed, ${number(c("killsAfter"))} after an action, ${number(c("killsBetween"))} between actions` +
            ` (${number(c("killsDuringReconcileRead"))} while checking an unknown result, ${number(c("killsBeforeTickCompleted"))} right after a restart); plus ${number(c("downtimeRestarts"))} laptop shutdowns`,
        ],
        [
          "Unknown results checked",
          `${number(c("reconcileConfirmedSent"))} found sent, ${number(c("reconcileRetried"))} found not sent and sent again, ${number(c("reconcileHeld"))} held for review, ${number(c("reconcileNotRetried"))} not sent again`,
        ],
        ["Safety stops", `${number(c("safetyStopCheckpoint"))} security checkpoint, ${number(c("safetyStopLimit"))} LinkedIn invitation limit, ${number(c("safetyStopOther"))} other`],
        ["Replies between read and send", number(c("repliesMidSend"))],
        ["Reads the laptop slept through", `${number(c("suspendedReadsPlanned"))} planned near the window's end, ${number(c("suspendedReadsRandom"))} random`],
        [
          "Sends the laptop slept through",
          `${number(c("suspendedSendsPlanned"))} planned (an invite, a withdrawal and a message each starting 8 min before closing, for 2 h), ${number(c("suspendedSendsRandom"))} random`,
        ],
        ["Changes in the app mid-tick", `${number(c("changesMidTick"))} (campaign paused, prospect rejected, prospect stopped)`],
        ["Settings changed mid-read", `${number(c("settingsChangedMidRead"))} (daily message limit lowered to the day's count, a follow-up cleared)`],
        ["Kills on reply and takeover paths", number(c("killsOnReplyAndTakeover"))],
        ["Kills in a burst", `${number(c("killsInBurst"))} (three a few seconds apart, in a long run without a break)`],
        ["Weeks stopped by the weekly limit", `${number(c("weeksStoppedByWeeklyLimit"))} (the weekly invite limit, not the daily one, ended invites)`],
        ["Full days after downtime at a limit", `${number(c("fullDaysAfterDowntimeAtLimit"))} (a whole working day after downtime that reached its invite or message limit)`],
        ["Longest run without a break", `${range(verdicts.map((verdict) => verdict.counts.longestRunWithoutBreak))} pieces of work, across kills and restarts`],
        ["People discovered", `${number(c("peopleDiscovered"))} (${number(c("cardsScored"))} cards scored, ${number(c("profilesOpenedForScoring"))} profiles opened for scoring)`],
        ["Days at a discovery limit", `${number(c("daysAtProfileViewLimit"))} at the profile-view limit, ${number(c("daysAtDiscoveryLimit"))} at the discovery-page limit`],
        ["Search caps", `${number(c("searchCaps"))} (LinkedIn's monthly search limit; not a safety stop)`],
        ["Kills on discovery", `${number(c("killsOnDiscovery"))} (a recommendations or search page, or a profile opened for scoring)`],
        ["Approval queue", `${number(c("awaitingApprovalReached"))} campaigns awaiting approval, ${number(c("discoveryResumedAfterApproval"))} times discovery resumed after a full waiting line was approved`],
        ["Discovered people invited", number(c("discoveredInvited"))],
        ["AI calls", `${number(c("aiCalls"))} answered (${number(c("aiCallsAtNight"))} at night, ${number(c("aiCallsDuringSafetyStop"))} during a safety stop), ${number(c("aiCallsRefused"))} refused while the AI was out`],
      ],
      "left",
    ),
  );

  lines.push("", "Day after each downtime (lowest–highest across runs, against that day's limits)");
  const downtimes = verdicts[0]?.daysAfterDowntime.length ?? 0;
  for (let index = 0; index < downtimes; index++) {
    const days = verdicts.flatMap((verdict) => verdict.daysAfterDowntime[index] ?? []);
    const sample = days[0];
    if (sample === undefined) continue;
    const [from, to] = sample.downtime.split(" → ");
    const over = days.filter((day) => day.invites > day.allowance || day.messages > day.messageLimit).length;
    const full = sample.full ? `; a full working day, at its invite or message limit in ${days.filter((day) => day.atLimit).length} of ${days.length} run(s)` : "";
    lines.push(
      `  off ${from ?? "?"} to ${to ?? "?"}: ${weekday(sample.day)} ${sample.day}: invites ${range(days.map((day) => day.invites))} (limit ${range(days.map((day) => day.allowance))}),` +
        ` messages ${range(days.map((day) => day.messages))} (limit ${range(days.map((day) => day.messageLimit))}); ${over === 0 ? "never over" : `over in ${over} run(s)`}${full}`,
    );
  }
  const total = verdicts.reduce((sum2, verdict) => sum2 + violationCount(verdict), 0);
  lines.push("", total === 0 ? "Result: no violations." : `Result: ${number(total)} violation(s).`);
  return lines;
}
