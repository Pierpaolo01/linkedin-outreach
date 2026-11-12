/**
 * Which words of a sent text the template's variables filled in, so the approval queue can set those apart.
 * Read from the template's own `{{variable}}` positions, never by looking for the person's values in the text:
 * a fixed word the user wrote ("hotels in Rome") is never taken for a value, even when it equals one.
 */

export interface Segment {
  readonly text: string;
  /** True for words a variable filled in for this person; false for the template's fixed words. */
  readonly filled: boolean;
}

/** `{{name}}`, with optional whitespace inside the braces, as the engine reads it (`src/engine/template.ts`). */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** The template as fixed text and slots. Variables with nothing between them form one slot (their split is unknowable). */
type Part = { readonly kind: "fixed"; readonly text: string } | { readonly kind: "slot"; readonly names: readonly string[] };

function partsOf(template: string): Part[] {
  const parts: Part[] = [];
  let from = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const literal = template.slice(from, match.index);
    const name = match[1] ?? "";
    const last = parts.at(-1);
    if (literal === "" && last?.kind === "slot") parts[parts.length - 1] = { kind: "slot", names: [...last.names, name] };
    else parts.push({ kind: "fixed", text: literal }, { kind: "slot", names: [name] });
    from = match.index + match[0].length;
  }
  parts.push({ kind: "fixed", text: template.slice(from) });
  // The engine trims the rendered text, so the template's outer whitespace never reaches it.
  const first = parts[0];
  if (first?.kind === "fixed") parts[0] = { kind: "fixed", text: first.text.trimStart() };
  const end = parts.at(-1);
  if (end?.kind === "fixed") parts[parts.length - 1] = { kind: "fixed", text: end.text.trimEnd() };
  return parts.filter((part) => part.kind === "slot" || part.text !== "");
}

/** Cuts tried before giving up: a template's fixed text rarely repeats, so a real text needs a handful. */
const MAX_TRIES = 10_000;

/**
 * `text` (as the engine rendered `template` for one person) cut into fixed and filled segments, in order; or null when
 * the text does not follow the template (then nothing should be set apart). A variable used twice must have the same
 * value both times; when a fixed piece also occurs inside a value, the next cut is tried.
 */
export function filledSegments(template: string, text: string): readonly Segment[] | null {
  const parts = partsOf(template);
  let tries = 0;

  const match = (index: number, at: number, values: ReadonlyMap<string, string>): Segment[] | null => {
    tries += 1;
    if (tries > MAX_TRIES) return null;
    const part = parts[index];
    if (part === undefined) return at === text.length ? [] : null;
    if (part.kind === "fixed") {
      if (!text.startsWith(part.text, at)) return null;
      const rest = match(index + 1, at + part.text.length, values);
      return rest === null ? null : [{ text: part.text, filled: false }, ...rest];
    }
    const take = (end: number): Segment[] | null => {
      const value = text.slice(at, end);
      const [only] = part.names;
      const known = part.names.length === 1 && only !== undefined ? values.get(only) : undefined;
      if (value === "" || (known !== undefined && known !== value)) return null;
      const next = part.names.length === 1 && only !== undefined ? new Map(values).set(only, value) : values;
      const rest = match(index + 1, end, next);
      return rest === null ? null : [{ text: value, filled: true }, ...rest];
    };
    const following = parts[index + 1];
    // Fixed text always follows a slot, unless the slot ends the template.
    if (following === undefined || following.kind !== "fixed") return take(text.length);
    for (let end = text.indexOf(following.text, at + 1); end !== -1; end = text.indexOf(following.text, end + 1)) {
      const found = take(end);
      if (found !== null) return found;
    }
    return null;
  };

  return match(0, 0, new Map());
}
