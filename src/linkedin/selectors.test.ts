import { describe, expect, it } from "vitest";
import { languageFromHtml, languageFromLang, pageLanguage, selectorsFor } from "./selectors";

describe("interface language pick", () => {
  it.each([
    ["it", "it"],
    ["it-IT", "it"],
    ["IT_it", "it"],
    ["en", "en"],
    ["en-US", "en"],
  ] as const)("lang=%s picks %s", (lang, expected) => {
    expect(languageFromLang(lang)).toBe(expected);
  });

  it.each([null, "", "fr-FR", "de"])("falls back to English for lang=%o", (lang) => {
    expect(languageFromLang(lang)).toBe("en");
  });

  it("reads the <html lang> attribute from saved HTML", () => {
    expect(languageFromHtml('<!DOCTYPE html><html class="x" lang="it-IT" dir="ltr"><head>')).toBe(
      "it",
    );
    expect(languageFromHtml("<html lang='en'>")).toBe("en");
    expect(languageFromHtml("<html><body lang=\"it\">")).toBe("en");
  });

  it("reads the lang attribute from a live page", async () => {
    const page = { locator: () => ({ getAttribute: async () => "it-IT" }) };
    expect(await pageLanguage(page)).toBe("it");
  });

  it("gives each language its own wording", () => {
    expect(selectorsFor("it").restrictedNotices).toContain("il tuo account è stato limitato");
    expect(selectorsFor("en").restrictedNotices).toContain("your account has been restricted");
  });
});
