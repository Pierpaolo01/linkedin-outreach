import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it("leaves a plain value as it is", () => {
    expect(csvCell("Test Person 1")).toBe("Test Person 1");
    expect(csvCell(7.5)).toBe("7.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("quotes a value holding a comma, a quote or a line break, doubling quotes", () => {
    expect(csvCell("Founder, CEO")).toBe('"Founder, CEO"');
    expect(csvCell('The "best" company')).toBe('"The ""best"" company"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it.each(["=HYPERLINK(\"http://evil.example\")", "+39 02 1234", "-1+2", "@SUM(A1)", "\tTab", "\rReturn"])(
    "prefixes a cell that a spreadsheet would read as a formula: %j",
    (value) => {
      expect(csvCell(value).replace(/^"/, "").startsWith(`'${value.slice(0, 1)}`)).toBe(true);
    },
  );

  it("prefixes and quotes together", () => {
    expect(csvCell('=1,"x"')).toBe(`"'=1,""x"""`);
  });

  it("writes a date as an ISO instant", () => {
    expect(csvCell(new Date("2026-11-16T09:00:00Z"))).toBe("2026-11-16T09:00:00.000Z");
  });
});

describe("toCsv", () => {
  it("writes a header and rows with CRLF line ends", () => {
    expect(toCsv(["name", "score"], [["Test Person 1", 8], ["Test, Person 2", null]])).toBe(
      'name,score\r\nTest Person 1,8\r\n"Test, Person 2",\r\n',
    );
  });
});
