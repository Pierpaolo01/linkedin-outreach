/**
 * Child process for `sigkill.test.ts`: opens the database durably, commits one ledger row, starts a
 * second transaction without committing it, says "ready", and waits to be killed.
 */
import { openDb } from "../../db/index";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: sigkillChild.ts <database file>");

const { sqlite } = openDb(file);
const insert = sqlite.prepare("INSERT INTO actions (type, status, idempotency_key, attempts, started_at) VALUES ('health_check', 'done', ?, 1, ?)");
insert.run("sigkill:committed", Date.now());
sqlite.exec("BEGIN IMMEDIATE");
insert.run("sigkill:uncommitted", Date.now());
process.stdout.write("ready\n");
// Keeps the process alive, transaction open, until the parent sends SIGKILL.
process.stdin.resume();
