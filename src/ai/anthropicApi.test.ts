import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicApi } from "./anthropicApi";
import { AiUnavailable } from "./types";

/** The item at `index`, failing the test when there is none. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at ${index}`);
  return item;
}

const KEY = "sk-ant-test-DO-NOT-LEAK-1234567890";
const REQUEST = {
  system: "You answer with JSON only.",
  prompt: "Score these cards",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};

let dir: string;
let secrets: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-api-test-"));
  secrets = join(dir, "secrets.json");
  writeFileSync(secrets, JSON.stringify({ anthropicApiKey: KEY }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OK_BODY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"ok":true}' }],
};

async function failure(promise: Promise<unknown>): Promise<AiUnavailable> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AiUnavailable);
  const unavailable = error as AiUnavailable;
  const cause = unavailable.cause instanceof Error ? unavailable.cause.message : String(unavailable.cause ?? "");
  expect(`${unavailable.message} ${String(unavailable)} ${cause}`).not.toContain(KEY);
  return unavailable;
}

describe("anthropicApi", () => {
  it("posts a Messages request with the key from secrets.json and returns the text and model", async () => {
    const { fetch, calls } = mockFetch(() => json(200, OK_BODY));
    const completion = await createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST);

    expect(completion).toEqual({ text: '{"ok":true}', model: "claude-opus-5-5" });
    expect(calls).toHaveLength(1);
    const call = nth(calls, 0);
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2026-10-21");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("claude-opus-5-5");
    expect(body["system"]).toBe(REQUEST.system);
    expect(body["messages"]).toEqual([{ role: "user", content: REQUEST.prompt }]);
    expect(body["output_config"]).toEqual({ format: { type: "json_schema", schema: REQUEST.schema } });
    expect(body["fallbacks"]).toBe("default");
    expect(headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
  });

  it("uses the configured model and leaves out fallbacks for a model without them", async () => {
    const { fetch, calls } = mockFetch(() => json(200, { ...OK_BODY, model: "claude-haiku-5-5" }));
    const completion = await createAnthropicApi({ secretsFile: secrets, fetch, model: "claude-haiku-5-5" }).complete(REQUEST);
    expect(completion.model).toBe("claude-haiku-5-5");
    const body = JSON.parse(String(nth(calls, 0).init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("claude-haiku-5-5");
    expect(body).not.toHaveProperty("fallbacks");
    expect(new Headers(nth(calls, 0).init.headers).has("anthropic-beta")).toBe(false);
  });

  it("is unavailable when the key is rejected (401)", async () => {
    const { fetch } = mockFetch(() =>
      json(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }),
    );
    const error = await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
    expect(error.message).toMatch(/key was rejected/);
  });

  it("is unavailable when rate limited (429)", async () => {
    const { fetch } = mockFetch(() => json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    const error = await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
    expect(error.message).toMatch(/rate limit/i);
  });

  it("is unavailable on a server error (500)", async () => {
    const { fetch } = mockFetch(() => new Response("<html>oops</html>", { status: 500 }));
    const error = await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
    expect(error.message).toMatch(/500/);
  });

  it("is unavailable on a network error", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
    expect(error.message).toMatch(/could not reach/i);
  });

  it("is unavailable when the model declines", async () => {
    const { fetch } = mockFetch(() => json(200, { ...OK_BODY, stop_reason: "refusal", content: [] }));
    const error = await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
    expect(error.message).toMatch(/declined/);
  });

  it("is unavailable with setup advice when there is no key", async () => {
    const { fetch, calls } = mockFetch(() => json(200, OK_BODY));
    const error = await failure(createAnthropicApi({ secretsFile: join(dir, "missing.json"), fetch }).complete(REQUEST));
    expect(error.message).toMatch(/anthropicApiKey/);
    expect(calls).toHaveLength(0);
  });

  it("is unavailable when secrets.json has no usable key", async () => {
    writeFileSync(secrets, JSON.stringify({ somethingElse: KEY }));
    const { fetch } = mockFetch(() => json(200, OK_BODY));
    await failure(createAnthropicApi({ secretsFile: secrets, fetch }).complete(REQUEST));
  });
});
