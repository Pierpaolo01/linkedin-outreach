import { describe, expect, it } from "vitest";
import { filledSegments } from "./filled";

const fixed = (text: string) => ({ text, filled: false });
const filled = (text: string) => ({ text, filled: true });

describe("filledSegments", () => {
  it("marks only what the variables filled in, never a fixed word that equals a person's value", () => {
    // The person lives in Rome: the user's own "Rome" stays a fixed word.
    expect(filledSegments("Hi {{first_name}}, I work with hotels in Rome like {{company}}.", "Hi Anna, I work with hotels in Rome like Hotel Roma.")).toEqual([
      fixed("Hi "),
      filled("Anna"),
      fixed(", I work with hotels in Rome like "),
      filled("Hotel Roma"),
      fixed("."),
    ]);
  });

  it("reads a value that repeats a fixed word as one value", () => {
    expect(filledSegments("{{company}} in Rome.", "Rome Hotels in Rome.")).toEqual([filled("Rome Hotels"), fixed(" in Rome.")]);
  });

  it("gives a variable used twice the same value both times, trying a later cut when the first one disagrees", () => {
    expect(filledSegments("{{first_name}} x {{company}} x {{first_name}}", "A x B x C x A")).toEqual([
      filled("A"),
      fixed(" x "),
      filled("B x C"),
      fixed(" x "),
      filled("A"),
    ]);
  });

  it("accepts spaces inside the braces, and a text trimmed at both ends as the engine sends it", () => {
    expect(filledSegments("  Thanks {{ first_name }}\n", "Thanks Anna")).toEqual([fixed("Thanks "), filled("Anna")]);
  });

  it("joins two variables with nothing between them into one value", () => {
    expect(filledSegments("{{first_name}}{{company}}!", "AnnaAcme!")).toEqual([filled("AnnaAcme"), fixed("!")]);
  });

  it("returns the text as fixed when the template has no variables", () => {
    expect(filledSegments("No variables here.", "No variables here.")).toEqual([fixed("No variables here.")]);
  });

  it("returns null when the text does not follow the template", () => {
    expect(filledSegments("Hi {{first_name}}", "Hello Anna")).toBeNull();
    expect(filledSegments("Hi {{first_name}}.", "Hi .")).toBeNull();
    expect(filledSegments("No variables here.", "Other words.")).toBeNull();
  });
});
