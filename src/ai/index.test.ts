import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAi } from "./index";
import { createFakeAi } from "./fakeAi";
import { runAiSelfTest } from "./selfTest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-ai-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CLEAN_ANSWER = JSON.stringify({ firstName: "Marco", companyShort: "Rossi Costruzioni" });

describe("createAi", () => {
  it("uses the claude CLI with the configured model", async () => {
    const binary = join(dir, "claude");
    const envelope = JSON.stringify({ type: "result", is_error: false, structured_output: JSON.parse(CLEAN_ANSWER) });
    writeFileSync(binary, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\ncat > /dev/null\necho '${envelope}'\n`, { mode: 0o755 });

    const ai = createAi({ provider: "claude_cli", model: "sonnet" }, { claudeCli: { binary, cwd: dir } });
    const answer = await ai.cleanVariables({ fullName: "Dott. Marco Rossi", company: "ROSSI COSTRUZIONI S.R.L." });

    expect(answer).toEqual({ value: { firstName: "Marco", companyShort: "Rossi Costruzioni" }, model: "sonnet" });
  });

  it("uses the Anthropic API with the configured model", async () => {
    const secretsFile = join(dir, "secrets.json");
    writeFileSync(secretsFile, JSON.stringify({ anthropicApiKey: "sk-ant-test" }));
    const models: string[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      const body = { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: CLEAN_ANSWER }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof globalThis.fetch;

    const ai = createAi({ provider: "anthropic_api", model: "claude-sonnet-5-5" }, { anthropicApi: { secretsFile, fetch } });
    const answer = await ai.cleanVariables({ fullName: "Marco Rossi", company: "Rossi Costruzioni" });

    expect(answer.model).toBe("claude-sonnet-5-5");
    expect(models).toEqual(["claude-sonnet-5-5"]);
  });
});

describe("runAiSelfTest", () => {
  it("runs one name cleaning and one card scoring and times them", async () => {
    let clock = 0;
    const result = await runAiSelfTest(createFakeAi(), () => (clock += 250));

    expect(result.cleaned.value).toEqual({ firstName: "Marco", companyShort: "Rossi Costruzioni" });
    expect(result.cleaned.model).toBe("fake");
    expect(result.scored.value).toHaveLength(2);
    expect(result.cleanMs).toBe(250);
    expect(result.scoreMs).toBe(250);
  });
});
