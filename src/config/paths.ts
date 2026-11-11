import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything the app stores lives in one data directory outside the repo,
 * so an update never touches data. Tests point it elsewhere with the env var.
 */
export function dataDir(): string {
  return (
    process.env["LINKEDIN_OUTREACH_DATA_DIR"] ??
    join(homedir(), "Library", "Application Support", "linkedin-outreach")
  );
}

export interface DataPaths {
  readonly root: string;
  readonly db: string;
  readonly backups: string;
  readonly chromeProfile: string;
  readonly screenshots: string;
  readonly logs: string;
  readonly secrets: string;
}

export function dataPaths(root: string = dataDir()): DataPaths {
  return {
    root,
    db: join(root, "app.db"),
    backups: join(root, "backups"),
    chromeProfile: join(root, "chrome-profile"),
    screenshots: join(root, "screenshots"),
    logs: join(root, "logs"),
    secrets: join(root, "secrets.json"),
  };
}
