/**
 * The AI the app uses, picked from Settings (spec section 8). The engine depends on `Ai` from
 * `types.ts` only; this is where a provider is chosen and wrapped in the four tasks.
 */
import type { Settings } from "../config/settings";
import { createAnthropicApi, type AnthropicApiOptions } from "./anthropicApi";
import { createClaudeCli, type ClaudeCliOptions } from "./claudeCli";
import type { AiProvider } from "./provider";
import { aiFromProvider } from "./tasks";
import type { Ai } from "./types";

export interface AiDeps {
  /** Overrides for the claude CLI backend (binary, working directory, timeout). The model comes from settings. */
  readonly claudeCli?: Omit<ClaudeCliOptions, "model"> | undefined;
  /** Overrides for the API backend (secrets file, fetch, timeout). The model comes from settings. */
  readonly anthropicApi?: Omit<AnthropicApiOptions, "model"> | undefined;
}

function providerFor(settings: Settings["ai"], deps: AiDeps): AiProvider {
  switch (settings.provider) {
    case "claude_cli":
      return createClaudeCli({ ...deps.claudeCli, model: settings.model });
    case "anthropic_api":
      return createAnthropicApi({ ...deps.anthropicApi, model: settings.model });
    default: {
      const unknown: never = settings.provider;
      throw new TypeError(`unknown AI provider ${String(unknown)}`);
    }
  }
}

export function createAi(settings: Settings["ai"], deps: AiDeps = {}): Ai {
  return aiFromProvider(providerFor(settings, deps));
}
