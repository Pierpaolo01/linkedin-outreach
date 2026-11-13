/**
 * Renders a campaign's message templates (spec section 9, step 5). Fails closed: a text with an
 * unresolved, unknown or broken `{{variable}}` is never returned, not even in part, so the caller
 * moves the prospect to needs review instead of sending it (spec section 8, "Fallbacks").
 */

export const TEMPLATE_VARIABLES = ["first_name", "company", "title", "location", "industry", "ai_line"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Readonly<Partial<Record<TemplateVariable, string | null>>>;
export type RenderResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly problem: "unresolved_variable" | "unknown_variable" | "malformed" | "empty" | "too_long";
      readonly variables: readonly string[];
    };

/** `{{name}}` with optional whitespace inside the braces. A name holds no whitespace and no braces. */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const DOUBLE_BRACE = /\{\{|\}\}/;
const TRIPLE_BRACE = /\{\{\{|\}\}\}/;

interface Placeholder {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

function placeholdersIn(template: string): Placeholder[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => ({
    name: match[1] ?? "",
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function isTemplateVariable(name: string): name is TemplateVariable {
  return TEMPLATE_VARIABLES.some((variable) => variable === name);
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** The text between placeholders, in order. */
function literalsOf(template: string, placeholders: readonly Placeholder[]): string[] {
  const literals: string[] = [];
  let from = 0;
  for (const placeholder of placeholders) {
    literals.push(template.slice(from, placeholder.start));
    from = placeholder.end;
  }
  literals.push(template.slice(from));
  return literals;
}

/**
 * The AI line's closing full stop, when the template puts punctuation straight after it: the AI
 * writes a sentence, and "{{ai_line}}, would like to connect" must not read "business.,". An
 * ellipsis is kept. Only the AI line: another value's stop may be an abbreviation's ("Acme Inc.").
 */
function withoutDoubledStop(value: string, after: string): string {
  if (!/^[.,;:!?]/.test(after)) return value;
  const trimmed = value.trimEnd();
  if (!trimmed.endsWith(".") || trimmed.endsWith("..")) return value;
  return trimmed.slice(0, -1);
}

function failure(problem: Exclude<RenderResult, { ok: true }>["problem"], variables: readonly string[]): RenderResult {
  return { ok: false, problem, variables };
}

/** The variables a template uses, in order of first use, unknown names included. */
export function variablesIn(template: string): string[] {
  return unique(placeholdersIn(template).map((placeholder) => placeholder.name));
}

export function renderTemplate(template: string, values: TemplateValues, options?: { readonly maxLength?: number }): RenderResult {
  const maxLength = options?.maxLength;
  if (maxLength !== undefined && !(Number.isInteger(maxLength) && maxLength >= 0)) {
    throw new RangeError(`maxLength must be a whole number of zero or more, got ${String(maxLength)}`);
  }

  const placeholders = placeholdersIn(template);
  const literals = literalsOf(template, placeholders);
  if (TRIPLE_BRACE.test(template) || literals.some((literal) => DOUBLE_BRACE.test(literal))) {
    return failure("malformed", []);
  }

  const names = unique(placeholders.map((placeholder) => placeholder.name));
  const unknown = names.filter((name) => !isTemplateVariable(name));
  if (unknown.length > 0) return failure("unknown_variable", unknown);

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  for (const name of names) {
    const value = isTemplateVariable(name) ? values[name] : undefined;
    if (value === undefined || value === null || value.trim() === "") unresolved.push(name);
    else resolved.set(name, value);
  }
  if (unresolved.length > 0) return failure("unresolved_variable", unresolved);

  let rendered = literals[0] ?? "";
  placeholders.forEach((placeholder, index) => {
    const after = literals[index + 1] ?? "";
    const value = resolved.get(placeholder.name) ?? "";
    rendered += (placeholder.name === "ai_line" ? withoutDoubledStop(value, after) : value) + after;
  });
  if (DOUBLE_BRACE.test(rendered)) {
    const withBraces = names.filter((name) => /[{}]/.test(resolved.get(name) ?? ""));
    return failure("malformed", withBraces);
  }

  const text = rendered.trim();
  if (text === "") return failure("empty", []);
  if (maxLength !== undefined && text.length > maxLength) return failure("too_long", []);
  return { ok: true, text };
}
