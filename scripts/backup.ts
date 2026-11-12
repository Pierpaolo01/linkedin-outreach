import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { dataPaths } from "../src/config/paths";
import { backupNow } from "../src/ops/backup";

/**
 * `npm run backup`: a fresh backup of the database now, replacing today's once the copy checks out.
 * It does not take the app's instance lock (`app.lock`): SQLite's online backup reads a consistent
 * copy beside a running app's open connection and changes nothing in `app.db`.
 */
const paths = dataPaths();

if (!existsSync(paths.db)) {
  console.log(`backup: no database at ${paths.db} yet, nothing to back up`);
} else {
  const sqlite = new Database(paths.db, { fileMustExist: true });
  try {
    const outcome = await backupNow(sqlite, paths, new Date());
    switch (outcome.kind) {
      case "created":
        console.log(`backup: ${outcome.file} (${outcome.bytes} bytes, integrity ok)`);
        for (const file of outcome.removed) console.log(`backup: removed old ${file}`);
        break;
      case "skipped":
        console.log(`backup: ${outcome.file} already exists`);
        break;
      case "failed":
        console.error(`backup: FAILED: ${outcome.error}. Older backups were left as they were`);
        process.exitCode = 1;
        break;
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`unknown outcome ${String(_exhaustive)}`);
      }
    }
  } finally {
    sqlite.close();
  }
}
