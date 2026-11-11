import { z } from "zod";
import type { SessionStatus } from "../db/schema";

/** All the dashboard's calls to the app's API. Responses are validated: the UI trusts nothing it did not check. */

const SESSION_STATUSES = [
  "unknown",
  "ok",
  "logged_out",
  "checkpoint",
  "restricted",
  "search_capped",
] as const satisfies readonly SessionStatus[];

const sessionSchema = z.object({
  status: z.enum(SESSION_STATUSES),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  /** A check is running right now (the startup check or a Re-check). */
  checking: z.boolean(),
});

export type Session = z.infer<typeof sessionSchema>;

const errorSchema = z.object({ error: z.string() });
const failedSchema = errorSchema.extend({ session: sessionSchema });

export async function getSession(): Promise<Session> {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error(`The app answered ${res.status} for the session state`);
  return sessionSchema.parse(await res.json());
}

export type CheckResult =
  | { readonly kind: "checked"; readonly session: Session }
  | { readonly kind: "failed"; readonly session: Session; readonly error: string }
  | { readonly kind: "busy" };

/** Asks the app to check the LinkedIn session now. */
export async function checkSession(): Promise<CheckResult> {
  const res = await fetch("/api/session/check", { method: "POST" });
  const body: unknown = await res.json();
  if (res.ok) return { kind: "checked", session: sessionSchema.parse(body) };
  if (res.status === 409) return { kind: "busy" };
  if (res.status === 502) {
    const failed = failedSchema.parse(body);
    return { kind: "failed", session: failed.session, error: failed.error };
  }
  const parsed = errorSchema.safeParse(body);
  throw new Error(parsed.success ? parsed.data.error : `The app answered ${res.status} to the session check`);
}
