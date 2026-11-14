import { describe, expect, it } from "vitest";
import { aiLineRoom, renderTemplate, variablesIn, type TemplateValues } from "./template";

const marco: TemplateValues = {
  first_name: "Marco",
  company: "Rossi Srl",
  title: "Founder",
  location: "Milan",
  industry: "Logistics",
  ai_line: "Saw your post on cold-chain routing.",
};

describe("renderTemplate", () => {
  it("fills every known variable", () => {
    expect(renderTemplate("Hi {{first_name}}, how is {{company}}?", marco)).toEqual({
      ok: true,
      text: "Hi Marco, how is Rossi Srl?",
    });
  });

  it("accepts spaces inside the braces", () => {
    expect(renderTemplate("{{ first_name }}|{{first_name }}|{{  first_name}}|{{\tfirst_name\t}}", marco)).toEqual({
      ok: true,
      text: "Marco|Marco|Marco|Marco",
    });
  });

  it("fills a variable used more than once", () => {
    expect(renderTemplate("{{first_name}}, {{first_name}}!", marco)).toEqual({ ok: true, text: "Marco, Marco!" });
  });

  it("keeps the lines of a multi-line template and trims the result", () => {
    const template = "\n  Hi {{first_name}},\n\n{{ai_line}}\n\nBest,\nAlex\n  ";
    expect(renderTemplate(template, marco)).toEqual({
      ok: true,
      text: "Hi Marco,\n\nSaw your post on cold-chain routing.\n\nBest,\nAlex",
    });
  });

  it("inserts values as they are, special replacement patterns included", () => {
    expect(renderTemplate("Hi {{first_name}}", { first_name: "$& $1 $$ M" })).toEqual({ ok: true, text: "Hi $& $1 $$ M" });
  });

  it("drops a value's full stop when the template puts punctuation right after it", () => {
    const template = "Hey {{first_name}}, {{ai_line}}, would like to connect!";
    expect(renderTemplate(template, { first_name: "Edzard", ai_line: "I saw your agency's work." })).toEqual({
      ok: true,
      text: "Hey Edzard, I saw your agency's work, would like to connect!",
    });
    expect(renderTemplate("{{ai_line}}. Talk soon", { ai_line: "Great post." })).toEqual({ ok: true, text: "Great post. Talk soon" });
    expect(renderTemplate("{{ai_line}}!", { ai_line: "Nice." })).toEqual({ ok: true, text: "Nice!" });
  });

  it("keeps a value's full stop before a space or a word, and keeps an ellipsis", () => {
    expect(renderTemplate("{{ai_line}} Would like to connect", { ai_line: "Great post." })).toEqual({ ok: true, text: "Great post. Would like to connect" });
    expect(renderTemplate("{{ai_line}}, ok", { ai_line: "Wait..." })).toEqual({ ok: true, text: "Wait..., ok" });
    expect(renderTemplate("{{company}}, hi", { company: "Acme Inc." })).toEqual({ ok: true, text: "Acme Inc., hi" });
  });

  it("leaves single braces in the text alone", () => {
    expect(renderTemplate("Hi {first_name} :-} {{first_name}}", marco)).toEqual({
      ok: true,
      text: "Hi {first_name} :-} Marco",
    });
  });

  it("lists every known variable whose value is missing, null or blank", () => {
    expect(
      renderTemplate("{{first_name}} {{company}} {{title}} {{location}} {{company}}", {
        first_name: "Marco",
        company: null,
        title: "  \n ",
      }),
    ).toEqual({ ok: false, problem: "unresolved_variable", variables: ["company", "title", "location"] });
  });

  it("refuses a name that is not a template variable", () => {
    expect(renderTemplate("Hi {{ firstName }} at {{company}} {{First_Name}}", marco)).toEqual({
      ok: false,
      problem: "unknown_variable",
      variables: ["firstName", "First_Name"],
    });
  });

  it("refuses an unknown name even when known variables are also unresolved", () => {
    expect(renderTemplate("{{nickname}} {{first_name}}", {})).toEqual({
      ok: false,
      problem: "unknown_variable",
      variables: ["nickname"],
    });
  });

  it.each([
    ["an unclosed placeholder", "Hi {{first_name"],
    ["a stray closing pair", "Hi first_name}}"],
    ["an empty placeholder", "Hi {{}} there"],
    ["a placeholder holding only spaces", "Hi {{   }} there"],
    ["a nested placeholder", "Hi {{ {{first_name}} }}"],
    ["triple braces", "Hi {{{first_name}}}"],
    ["a placeholder split by a line break", "Hi {{first\n_name}}"],
  ])("refuses %s as malformed", (_case, template) => {
    expect(renderTemplate(template, marco)).toMatchObject({ ok: false, problem: "malformed" });
  });

  it("never re-expands a value that holds braces", () => {
    expect(renderTemplate("Hi {{first_name}}", { first_name: "{{company}}", company: "Rossi" })).toEqual({
      ok: false,
      problem: "malformed",
      variables: ["first_name"],
    });
    expect(renderTemplate("{{ai_line}}", { ai_line: "done }} here" })).toMatchObject({ ok: false, problem: "malformed" });
  });

  it("refuses braces formed where a value meets the template text", () => {
    expect(renderTemplate("{{{first_name}}", { first_name: "{x" })).toMatchObject({ ok: false, problem: "malformed" });
    expect(renderTemplate("a{{first_name}}{ b", { first_name: "x{" })).toMatchObject({ ok: false, problem: "malformed" });
  });

  it("refuses an empty result", () => {
    expect(renderTemplate("", marco)).toEqual({ ok: false, problem: "empty", variables: [] });
    expect(renderTemplate(" \n\t ", marco)).toEqual({ ok: false, problem: "empty", variables: [] });
  });

  it("accepts a result exactly at maxLength and refuses one unit over", () => {
    const at = renderTemplate(`${"a".repeat(295)} {{first_name}}`, { first_name: "Mar" }, { maxLength: 299 });
    expect(at).toEqual({ ok: true, text: `${"a".repeat(295)} Mar` });
    expect(renderTemplate(`${"a".repeat(295)} {{first_name}}`, { first_name: "Marc" }, { maxLength: 299 })).toEqual({
      ok: false,
      problem: "too_long",
      variables: [],
    });
  });

  it("measures maxLength after trimming", () => {
    expect(renderTemplate("   abc   ", {}, { maxLength: 3 })).toEqual({ ok: true, text: "abc" });
  });

  it("counts maxLength in UTF-16 code units, so an emoji counts as two", () => {
    expect(renderTemplate("ab🚀", {}, { maxLength: 4 })).toEqual({ ok: true, text: "ab🚀" });
    expect(renderTemplate("abc🚀", {}, { maxLength: 4 })).toMatchObject({ ok: false, problem: "too_long" });
  });

  it("refuses a maxLength that is not a whole number", () => {
    expect(() => renderTemplate("Hi", {}, { maxLength: Number.NaN })).toThrow(RangeError);
    expect(() => renderTemplate("Hi", {}, { maxLength: -1 })).toThrow(RangeError);
    expect(() => renderTemplate("Hi", {}, { maxLength: 2.5 })).toThrow(RangeError);
  });
});

describe("variablesIn", () => {
  it("lists variables in order of first use, unknown names included", () => {
    expect(variablesIn("{{ company }} {{first_name}} {{nickname}} {{company}} {{first_name}}")).toEqual([
      "company",
      "first_name",
      "nickname",
    ]);
  });

  it("lists nothing for a template without placeholders", () => {
    expect(variablesIn("Hi there, {single} braces")).toEqual([]);
  });
});

describe("aiLineRoom", () => {
  const values: TemplateValues = { first_name: "Luc" };

  it("is what the filled template leaves of the limit for the line", () => {
    // "Hey Luc, " and ", would like to connect!" take 33 of 200.
    expect(aiLineRoom("Hey {{first_name}}, {{ai_line}}, would like to connect!", values, 200)).toBe(167);
    const line = "y".repeat(167);
    const filled = renderTemplate("Hey {{first_name}}, {{ai_line}}, would like to connect!", { ...values, ai_line: line }, { maxLength: 200 });
    expect(filled.ok).toBe(true);
  });

  it("shares the room between two uses of the line", () => {
    expect(aiLineRoom("{{ai_line}} / {{ai_line}}", values, 103)).toBe(50);
  });

  it("is null without {{ai_line}} or when another variable is unresolved", () => {
    expect(aiLineRoom("Hi {{first_name}}", values, 200)).toBeNull();
    expect(aiLineRoom("Hi {{company}}, {{ai_line}}", values, 200)).toBeNull();
  });

  it("is zero or less when the rest of the template already fills the limit", () => {
    expect(aiLineRoom(`${"x".repeat(200)} {{ai_line}}`, values, 200)).toBeLessThanOrEqual(0);
  });
});
