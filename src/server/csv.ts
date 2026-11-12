/**
 * CSV for the prospect export (RFC 4180: comma-separated, CRLF line ends, a field quoted when it
 * holds a comma, quote or line break, quotes doubled). Safe to open in a spreadsheet: a cell that
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a single quote, so it
 * is read as text and never as a formula.
 */

export type CsvValue = string | number | boolean | Date | null;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: CsvValue): string {
  if (value === null) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return [header, ...rows].map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}
