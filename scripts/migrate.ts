import { z } from "zod";
import { dataPaths } from "../src/config/paths";
import { ensureDataDir, openDb } from "../src/db/index";

/** Used by `npm run setup`: create the data directory, then apply pending migrations. */
const step = process.argv[2];
const paths = dataPaths();

if (step === "data-dir") {
  ensureDataDir(paths);
  console.log(`data directory: ${paths.root} (backups, chrome-profile, screenshots, logs; mode 700)`);
} else if (step === "migrate") {
  const { sqlite, close } = openDb(paths.db);
  const { n } = z.object({ n: z.number() }).parse(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get());
  close();
  console.log(`migrations: ${n} applied to ${paths.db}`);
} else {
  console.error("usage: tsx scripts/migrate.ts data-dir|migrate");
  process.exitCode = 2;
}
