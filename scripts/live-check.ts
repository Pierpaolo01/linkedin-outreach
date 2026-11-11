/**
 * `npm run live:check [-- --keywords "<words>"] [-- --thread-member <member id>]`
 *
 * Runs every read-only driver operation once against the real account in the
 * dedicated window and checks that each returns well-formed data (handoff
 * section 5, item 3). Read-only: it loads pages and scrolls; it never clicks
 * or types. Pages are spaced 20–40 s apart. `readThread` runs on the newest
 * connection, who often has no conversation yet; `--thread-member` adds a read
 * of a person the user has exchanged messages with, which must return messages.
 *
 * Stdout holds states and counts only. The parsed results, which contain real
 * people's data, go to `<data dir>/live-check/<timestamp>.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataPaths } from "../src/config/paths";
import { openDedicatedWindow, ProfileInUse, type DedicatedWindow } from "../src/linkedin/browser";
import { createLiveDriver, driverPageFor } from "../src/linkedin/driver";
import { LinkedInError } from "../src/linkedin/errors";
import { navigationStateFile, paceNavigation } from "../src/linkedin/human";
import { flattenRecommendations } from "../src/linkedin/parse/recommendations";

const publicId = z.string().regex(/^[^/?#\s]+$/);
const profileUrl = z.string().regex(/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/$/);
const card = z.object({
  publicId,
  profileUrl,
  fullName: z.string().min(1),
  headline: z.string().min(1).nullable(),
  degree: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
});
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const shapes = {
  search: z.object({ cards: z.array(card).min(1), hasNextPage: z.boolean(), capped: z.boolean() }),
  recommendations: z.array(card).min(1),
  profile: card.extend({
    connectionState: z.enum(["can_connect", "connect_in_more", "pending", "connected", "follow_only", "unknown"]),
    messageAvailable: z.boolean(),
    memberId: z.string().regex(/^ACoA[\w-]+$/).nullable(),
    experience: z.array(z.object({ title: z.string().min(1) })),
  }),
  connections: z
    .array(card.extend({ degree: z.literal(1), connectedOn: isoDay.nullable(), memberId: z.string().regex(/^ACoA[\w-]+$/).nullable() }))
    .min(1),
  invitations: z.array(card),
  thread: z.object({
    participant: z.object({ fullName: z.string().min(1), publicId: z.string().min(1) }),
    kind: z.enum(["message", "inmail", "sponsored", "unknown"]),
    messages: z.array(z.object({ sender: z.enum(["user", "participant"]), senderName: z.string().min(1), text: z.string().min(1) })),
    isNew: z.boolean(),
    threadUrl: z.string().nullable(),
  }),
};

/** The paths and codes of a zod failure, never the offending values. */
function problems(error: z.ZodError): string {
  const lines = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
  return `${error.issues.length} problem(s): ${lines.join("; ")}`;
}

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const keywords = option(process.argv.slice(2), "--keywords") ?? "marketing";
  const threadMember = option(process.argv.slice(2), "--thread-member");
  let window: DedicatedWindow;
  try {
    window = await openDedicatedWindow();
  } catch (error) {
    if (error instanceof ProfileInUse) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  process.once("SIGINT", () => void window.close().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void window.close().finally(() => process.exit(143)));

  const results: Record<string, unknown> = {};
  let failed = 0;
  let stopped = false;

  /** Runs one operation; prints one line; a safety stop ends the whole check. */
  async function check<T>(name: string, run: () => Promise<T>, shape: z.ZodType, counts: (value: T) => string): Promise<T | undefined> {
    if (stopped) {
      console.log(`skip ${name} (stopped)`);
      failed += 1;
      return undefined;
    }
    try {
      const value = await run();
      results[name] = value;
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        failed += 1;
        console.log(`FAIL ${name} ${counts(value)} — ${problems(parsed.error)}`);
        return value;
      }
      console.log(`ok ${name} ${counts(value)}`);
      return value;
    } catch (error) {
      failed += 1;
      if (error instanceof LinkedInError) {
        if (error.kind === "logged_out" || error.kind === "checkpoint" || error.kind === "restricted") stopped = true;
        // The message of an unexpected page names the saved files, not people.
        console.log(`FAIL ${name} ${error.kind}: ${error.message}`);
        return undefined;
      }
      console.log(`FAIL ${name} ${error instanceof Error ? error.name : "error"}`);
      results[`${name}Error`] = error instanceof Error ? (error.stack ?? error.message) : String(error);
      return undefined;
    }
  }

  try {
    const driver = createLiveDriver({
      page: driverPageFor(window.page),
      pace: () => paceNavigation({ stateFile: navigationStateFile(), minGapMs: 20_000, maxGapMs: 40_000 }),
    });

    await check("session", () => driver.ensureSession(), z.object({ state: z.literal("ok") }), (s) => `state=${s.state}`);
    if (!stopped) console.log(`lang ${await window.page.evaluate(() => document.documentElement.lang)}`);

    const search = await check(
      "searchPeople",
      () => driver.searchPeople({ keywords }),
      shapes.search,
      (r) => `cards=${r.cards.length} hasNextPage=${r.hasNextPage} capped=${r.capped} hidden=${r.hiddenMembers}`,
    );
    await check(
      "listRecommendations",
      async () => flattenRecommendations(await driver.listRecommendations()),
      shapes.recommendations,
      (cards) => `cards=${cards.length}`,
    );
    const first = search?.cards[0];
    if (first === undefined) {
      failed += 1;
      console.log("FAIL viewProfile no search card to open");
    } else {
      await check(
        "viewProfile",
        () => driver.viewProfile(first.publicId),
        shapes.profile,
        (p) => `degree=${p.degree} state=${p.connectionState} message=${p.messageAvailable} memberId=${p.memberId !== null} experience=${p.experience.length} about=${p.about !== null}`,
      );
    }
    const connections = await check(
      "listRecentConnections",
      () => driver.listRecentConnections(),
      shapes.connections,
      (c) => `cards=${c.length} dated=${c.filter((x) => x.connectedOn !== null).length} memberIds=${c.filter((x) => x.memberId !== null).length}`,
    );
    await check("listSentInvitations", () => driver.listSentInvitations(), shapes.invitations, (c) => `cards=${c.length}`);
    const connection = connections?.find((c) => c.memberId !== null);
    const memberId = connection?.memberId;
    if (connection === undefined || memberId == null) {
      failed += 1;
      console.log("FAIL readThread no connection with a member id to read");
    } else {
      await check(
        "readThread",
        () => driver.readThread({ memberId, publicId: connection.publicId }),
        shapes.thread,
        (t) =>
          `kind=${t.kind} isNew=${t.isNew} messages=${t.messages.length} fromUser=${t.messages.filter((m) => m.sender === "user").length} fromParticipant=${t.messages.filter((m) => m.sender === "participant").length} threadUrl=${t.threadUrl !== null}`,
      );
    }
    if (threadMember !== undefined) {
      await check(
        "readThread(existing)",
        () => driver.readThread({ memberId: threadMember }),
        shapes.thread.extend({ isNew: z.literal(false), messages: shapes.thread.shape.messages.min(1) }),
        (t) =>
          `kind=${t.kind} messages=${t.messages.length} fromUser=${t.messages.filter((m) => m.sender === "user").length} fromParticipant=${t.messages.filter((m) => m.sender === "participant").length} threadUrl=${t.threadUrl !== null}`,
      );
    }
  } finally {
    await window.close().catch(() => undefined);
  }

  const dir = join(dataPaths().root, "live-check");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  console.log(`results saved in the data directory: live-check/${file.split("/").pop() ?? ""}`);
  console.log(failed === 0 ? "live:check: OK" : `live:check: FAILED (${failed})`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
