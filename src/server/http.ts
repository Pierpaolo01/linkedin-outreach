/**
 * Shared pieces of the JSON API: how input is validated, how an outcome becomes a status code, and
 * the paging and id formats every route uses.
 */
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { Outcome } from "../campaigns/results";
import { fieldProblems, type FieldProblems } from "../campaigns/rules";
import type { StoredSession } from "./sessionStore";

export const FIELDS_ERROR = "Some fields need attention";

/** The body of every 400 for input that failed validation. */
export interface FieldsError {
  readonly error: string;
  readonly fields: FieldProblems;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly body: FieldsError };

/** Parses `value` with `schema`; on failure, a 400 body with one message per field. */
export function check<S extends z.ZodType>(schema: S, value: unknown, toProblems: (error: z.ZodError) => FieldProblems = fieldProblems): Checked<z.output<S>> {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, body: { error: FIELDS_ERROR, fields: toProblems(result.error) } };
}

/** Sends an outcome: the wrapped value with `okCode`, or 404 / 409 / 400 with `{ error }` (and `fields` for 400). */
export function sendOutcome<T>(reply: FastifyReply, outcome: Outcome<T>, wrap: (value: T) => unknown, okCode = 200): FastifyReply {
  if (outcome.ok) return reply.code(okCode).send(wrap(outcome.value));
  switch (outcome.kind) {
    case "not_found":
      return reply.code(404).send({ error: outcome.message });
    case "conflict":
      return reply.code(409).send({ error: outcome.message });
    case "invalid":
      return reply.code(400).send({ error: outcome.message, fields: outcome.fields });
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** A route's `:id`: a positive whole number, else null (the route answers 404). */
export function idParam(params: unknown): { readonly id: number | null; readonly raw: string } {
  const parsed = z.object({ id: z.string() }).safeParse(params);
  const raw = parsed.success ? parsed.data.id : "";
  return { id: /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null, raw };
}

/** Endpoints that take no input: anything sent is a mistake. */
export const noBody = z.union([z.undefined(), z.null(), z.object({}).strict()]);
export const NO_BODY_ERROR = { error: "This endpoint takes no body" } as const;

/** A request body that may be left out: a missing body reads as `{}`. */
export const orEmpty = (body: unknown): unknown => body ?? {};

const PAGE = "Enter a whole number of 1 or more";
const PAGE_SIZE = "Enter a whole number from 1 to 200";
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/** `?page=&pageSize=` (1-based; page size 1–200, default 50). */
export const pagingQuery = {
  page: z.coerce.number({ error: PAGE }).int({ error: PAGE }).min(1, { error: PAGE }).default(1),
  pageSize: z.coerce
    .number({ error: PAGE_SIZE })
    .int({ error: PAGE_SIZE })
    .min(1, { error: PAGE_SIZE })
    .max(MAX_PAGE_SIZE, { error: PAGE_SIZE })
    .default(DEFAULT_PAGE_SIZE),
};

const CAMPAIGN_ID = "Enter a campaign id (a whole number)";
/** An optional `?campaignId=` filter. */
export const campaignIdQuery = z.coerce.number({ error: CAMPAIGN_ID }).int({ error: CAMPAIGN_ID }).min(1, { error: CAMPAIGN_ID }).optional();

/** What the API says about the session. `checking` is true while a check runs. */
export function sessionJson(session: StoredSession, checking: boolean) {
  return {
    status: session.status,
    lastCheckedAt: session.lastCheckedAt?.toISOString() ?? null,
    lastError: session.lastError,
    checking,
  };
}
