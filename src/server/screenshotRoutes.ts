/**
 * `GET /api/screenshots/:name`: a screenshot the app saved (a page LinkedIn showed when something
 * went wrong), for the Needs review screen. Only a PNG directly inside the data directory's
 * `screenshots/` folder is served; any other name, a folder, or a link that leads out of the
 * folder is 404. The Host check of every route applies (`app.ts`).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SCREENSHOT_NAME } from "../campaigns/prospects";

const params = z.object({ name: z.string() });

/** The file's contents when `name` is a PNG inside `dir` (links resolved), else null. */
async function screenshot(dir: string, name: string): Promise<Buffer | null> {
  if (!SCREENSHOT_NAME.test(name)) return null;
  try {
    const folder = await realpath(dir);
    const file = await realpath(join(folder, name));
    if (!file.startsWith(folder + sep) || !(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

export function registerScreenshotRoutes(app: FastifyInstance, { screenshotsDir }: { readonly screenshotsDir: string }): void {
  app.get("/api/screenshots/:name", async (request, reply) => {
    const parsed = params.safeParse(request.params);
    const body = parsed.success ? await screenshot(screenshotsDir, parsed.data.name) : null;
    if (body === null) return reply.code(404).header("cache-control", "no-store").send({ error: "No such screenshot" });
    return reply.type("image/png").header("cache-control", "no-store").send(body);
  });
}
