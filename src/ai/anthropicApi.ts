/**
 * Backend 3 of spec section 8: the Anthropic Messages API with the user's own key.
 *
 * NOT TRIED AGAINST THE REAL API. There is no key on this laptop and none may be created, so this
 * file is tested only against a mocked `fetch` (anthropicApi.test.ts). Before relying on it, run
 * `npx tsx scripts/ai-test.ts` once with a real key and the provider set to `anthropic_api`.
 *
 * The key is read from `secrets.json` in the data directory, as `{"anthropicApiKey": "sk-ant-..."}`,
 * on every call (so a key added later works without a restart). It is never logged and never put in
 * an error message. Plain `fetch`, no SDK, by the slice's instruction; request shape from the
 * claude-api skill (API version 2026-10-21, structured outputs through `output_config.format`).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { dataPaths } from "../config/paths";
import type { AiProvider, Completion, CompletionRequest } from "./provider";
import { AiUnavailable } from "./types";

export interface AnthropicApiOptions {
  /** Empty or missing: `DEFAULT_MODEL`. */
  readonly model?: string | undefined;
  readonly secretsFile?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 16_000;

/**
 * Models that take server-side refusal fallbacks (`fallbacks: "default"`), per the claude-api skill.
 * Other models are sent without them.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const secretsSchema = z.object({ anthropicApiKey: z.string().trim().min(1) });

const messageSchema = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const errorSchema = z.object({ error: z.object({ type: z.string(), message: z.string() }) });

async function readKey(file: string): Promise<string> {
  const advice = `No Anthropic API key. Put {"anthropicApiKey": "sk-ant-..."} in ${file}, or choose the claude CLI in Settings.`;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new AiUnavailable(advice);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiUnavailable(`${file} is not valid JSON. ${advice}`);
  }
  const secrets = secretsSchema.safeParse(parsed);
  if (!secrets.success) throw new AiUnavailable(advice);
  return secrets.data.anthropicApiKey;
}

/** What the API said went wrong, with the key removed in case it was echoed back. */
async function apiMessage(response: Response, key: string): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message.replaceAll(key, "[key]").slice(0, 300) : "";
  } catch {
    return "";
  }
}

async function failure(response: Response, key: string): Promise<AiUnavailable> {
  const said = await apiMessage(response, key);
  const detail = said === "" ? "" : `: ${said}`;
  if (response.status === 401 || response.status === 403) {
    return new AiUnavailable(`The Anthropic API key was rejected (${response.status}). Check the key in secrets.json.`);
  }
  if (response.status === 429) {
    return new AiUnavailable(`The Anthropic API rate limit was reached (429); scoring will try again later${detail}`);
  }
  if (response.status >= 500) {
    return new AiUnavailable(`The Anthropic API is unavailable (${response.status}); scoring will try again later${detail}`);
  }
  return new AiUnavailable(`The Anthropic API refused the request (${response.status})${detail}`);
}

export function createAnthropicApi(options: AnthropicApiOptions = {}): AiProvider {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const secretsFile = options.secretsFile ?? dataPaths().secrets;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const key = await readKey(secretsFile);
      const fallbacks = FALLBACK_MODELS.has(model);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        ...(fallbacks ? { "anthropic-beta": FALLBACK_BETA } : {}),
      };
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        output_config: { format: { type: "json_schema", schema: request.schema } },
        ...(fallbacks ? { fallbacks: "default" } : {}),
      };

      let response: Response;
      try {
        response = await fetchFn(MESSAGES_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message.replaceAll(key, "[key]") : "unknown error";
        throw new AiUnavailable(`Could not reach the Anthropic API (${reason}).`);
      }
      if (!response.ok) throw await failure(response, key);

      let message: z.infer<typeof messageSchema>;
      try {
        message = messageSchema.parse(await response.json());
      } catch {
        throw new AiUnavailable("The Anthropic API sent a response this app does not understand.");
      }
      if (message.stop_reason === "refusal") throw new AiUnavailable("The model declined this request.");
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return { text, model: message.model };
    },
  };
}
