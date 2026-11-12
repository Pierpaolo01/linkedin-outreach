import { z } from "zod";
import { dataPaths } from "../src/config/paths";
import { isPortListening, restoreBackup } from "../src/ops/restore";
import { defaultServiceContext, serviceStatus } from "../src/ops/service";

/**
 * `npm run restore -- <file>`: restores a backup listed by `npm run doctor`.
 * The app counts as running when a live process holds the data directory's `app.lock` (an app on
 * any port does), and also when its port (PORT, default 4747) answers or the auto-start service
 * has a process; the restore then refuses and changes nothing. It holds the lock until it is done.
 */
const file = process.argv[2];
const port = z.coerce.number().int().min(1).max(65_535).default(4747).parse(process.env["PORT"]);

if (file === undefined || file === "") {
  console.error("usage: npm run restore -- <backup file>   (`npm run doctor` lists the backups)");
  process.exitCode = 2;
} else {
  const outcome = await restoreBackup({
    paths: dataPaths(),
    backup: file,
    now: new Date(),
    isAppRunning: async () => (await isPortListening(port)) || serviceStatus(defaultServiceContext()).pid !== null,
  });
  if (outcome.kind === "restored") {
    console.log(`restore: ${outcome.from} is now the database`);
    console.log(
      outcome.aside === null
        ? "restore: there was no current database to copy aside"
        : `restore: the previous database was kept as ${outcome.aside}`,
    );
    console.log("restore: start the app again (`npm start`, or `npm run service:restart` if it starts at login)");
  } else {
    console.error(`restore: REFUSED: ${outcome.reason}`);
    process.exitCode = 1;
  }
}
