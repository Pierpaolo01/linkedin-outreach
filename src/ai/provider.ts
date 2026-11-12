import { z } from "zod";

/**
 * The one thing a backend must do: send a system prompt and a user prompt, ask for JSON matching a
 * schema, and hand back the raw text with the model that wrote it. Parsing, validation and the retry
 * live in `tasks.ts`, so every backend gets the same checks.
 *
 * A backend throws `AiUnavailable` when it cannot get an answer at all (not installed, not logged in,
 * no key, network, timeout). Text that is not the JSON asked for is returned as is: the task layer
 * treats that as invalid output and retries once.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface CompletionRequest {
  readonly system: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
}

export interface Completion {
  /** The model's answer, expected to be JSON. */
  readonly text: string;
  readonly model: string;
}

export interface AiProvider {
  complete(request: CompletionRequest): Promise<Completion>;
}

/**
 * Keywords that structured outputs on the Anthropic API do not accept (numeric and length limits),
 * plus `$schema`. They are removed from what is sent; the zod schema still enforces them on the answer.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!UNSUPPORTED_KEYWORDS.has(key)) out[key] = strip(inner);
  }
  return out;
}

/** The JSON Schema a backend sends for `schema`. */
export function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  const stripped = strip(z.toJSONSchema(schema));
  if (!isRecord(stripped)) throw new TypeError("expected an object schema");
  return stripped;
}
