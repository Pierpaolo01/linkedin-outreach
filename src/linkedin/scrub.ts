/**
 * Turns a capture (a saved LinkedIn page with real people's data) into a fixture:
 * the same page structure with people, organisations, photos and identifiers replaced.
 *
 * Works on the HTML string with a small tag tokenizer rather than a DOM round trip,
 * so everything it does not replace stays byte for byte as LinkedIn wrote it.
 */

/** Strings a parser read from the page that identify real people or organisations. */
export interface Sensitive {
  readonly names?: readonly string[]; // people's full names
  readonly companies?: readonly string[]; // company and school names
  readonly texts?: readonly string[]; // headlines, locations, message bodies, about text, anything else personal
}

/** A 1x1 transparent GIF. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const BLANK = "about:blank";

/** Elements whose whole content is dropped. */
const EMPTIED = "script|style|noscript|template|iframe";
/** Attribute text inside a tag: quoted values may hold `>`. */
const TAG_BODY = `(?:"[^"]*"|'[^']*'|[^'">])*`;

/** A comment, an element to empty, or a `<code>` element, whichever comes first. */
const STRUCTURE = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)` +
    `|<(${EMPTIED})\\b(${TAG_BODY})>[\\s\\S]*?(?:<\\/\\1\\s*>|$)` +
    `|<code\\b(${TAG_BODY})>([\\s\\S]*?)<\\/code\\s*>`,
  "gi",
);

/** A tag, a doctype or other markup declaration. Everything between matches is text. */
const TAG = new RegExp(`<\\/?[a-zA-Z][^\\s/>]*${TAG_BODY}>|<![^>]*>`, "g");
const TAG_PARTS = /^<(\/?)([a-zA-Z][^\s/>]*)([\s\S]*?)(\/?)>$/;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const ABSOLUTE_URL = /^\s*(?:https?:)?\/\/([^/?#:"'\s\\]+)/i;
const LICDN_URL = /(?:https?:)?\/\/[a-z0-9.-]*licdn\.com(?:(?!&quot;|&#34;)[^\s"'<>)\\])*/gi;
const URL_OR_URN = /(?:https?:|%3A%2F%2F|\/\/|www\.|urn:li:|urn%3Ali%3A)/i;
/**
 * A profile, company or school link: raw (`/in/<id>/path?query`) or URL-encoded inside
 * another URL (`%2Fin%2F<id>`). The query and fragment of a raw link are matched to drop them.
 */
const LINK =
  /\/(in|company|school)\/([^/?#"'\s<>&\\]+)(\/[^?#"'\s<>&\\]*)?(?:[?#](?:(?!&quot;|&#34;)[^"'\s<>\\])*)?|%2[Ff](in|company|school)%2[Ff]((?:[A-Za-z0-9\-_.~]|%25[0-9A-Fa-f]{2})+)/g;
const LINK_PREFIX = { in: "person", company: "company", school: "school" } as const;

/** Attributes whose values are interface, not content: no known-string, phone or token replacement. */
const INTERFACE_ATTRIBUTES = new Set([
  "class", "id", "data-testid", "role", "type", "name", "for", "tabindex", "dir", "lang",
  "xmlns", "xmlns:xlink", "viewbox", "d", "points", "transform", "width", "height", "fill", "stroke",
]);
/**
 * A urn value: `urn:li:<type>:<value>`, raw or URL-encoded once or twice; the value is
 * an id, or a parenthesised compound that may hold other urns. A numeric id stops before
 * a `_suffix` (component keys such as `urn:li:member:123_connect`), also once replaced by `ID<n>`.
 */
const URN =
  /urn(:|%3[Aa]|%253[Aa])li\1([A-Za-z_]+)\1(\((?:[^()]|\([^()]*\))*\)|(?:%28|%2528)(?:(?!%29|%2529)[^\s"'<>&])*(?:%29|%2529)|(?:ID)?\d+(?![A-Za-z0-9=+-])|[A-Za-z0-9_=+-]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PLACEHOLDER_EMAIL = "person@example.com";
/** A run of digits, or an international number with separators; replaced only with enough digits. */
const PHONE = /\+\d[\d \u00a0().-]{6,}\d|\d{9,}/g;
const MIN_PHONE_DIGITS = 9;
const OPAQUE_TOKEN = /[A-Za-z0-9+_-]{40,}={0,2}/g;

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href", "background"]);
const REMOVED_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

interface Attribute {
  readonly name: string;
  readonly value: string | undefined;
  readonly quote: string;
  readonly raw: string;
}

export function scrubHtml(html: string, sensitive: Sensitive): string {
  const scrubber = new Scrubber(sensitive);
  const structural = html.replace(STRUCTURE, removeStructure);
  let out = "";
  let last = 0;
  for (const match of structural.matchAll(TAG)) {
    out += scrubber.text(structural.slice(last, match.index));
    out += scrubber.tag(match[0]);
    last = match.index + match[0].length;
  }
  return out + scrubber.text(structural.slice(last));
}

/** Numbers keys by first appearance. */
class Numbering {
  private readonly numbers = new Map<string, number>();

  of(key: string): number {
    let n = this.numbers.get(key);
    if (n === undefined) {
      n = this.numbers.size + 1;
      this.numbers.set(key, n);
    }
    return n;
  }
}

/** The replacement state of one `scrubHtml` call, so the same real value always gets the same stand-in. */
class Scrubber {
  private readonly links = { in: new Numbering(), company: new Numbering(), school: new Numbering() };
  private readonly urns = new Numbering();
  private readonly known: KnownStrings;

  constructor(sensitive: Sensitive) {
    this.known = knownStrings(sensitive);
  }

  /** Scrubs text content, or an attribute value of the given kind. */
  text(text: string, kind: ValueKind = "text"): string {
    let out = this.replaceLinks(text.replace(LICDN_URL, BLANK));
    if (kind !== "interface") out = this.known.replace(out);
    out = out.replace(URN, (_whole, separator: string, type: string, value: string) => {
      const n = this.urns.of(`${type}:${decodeFully(value)}`);
      return `urn${separator}li${separator}${type}${separator}ID${n}`;
    });
    out = out.replace(EMAIL, PLACEHOLDER_EMAIL);
    if (kind === "interface") return out;
    out = out.replace(PHONE, (run) => (countDigits(run) >= MIN_PHONE_DIGITS ? run.replace(/\d/g, "0") : run));
    if (kind === "attribute") out = out.replace(OPAQUE_TOKEN, (run) => (isOpaque(run) ? "TOKEN" : run));
    return out;
  }

  tag(tag: string): string {
    const parts = TAG_PARTS.exec(tag);
    if (parts === null || parts[1] === "/") return tag; // closing tag or declaration
    const [, , name = "", body = "", selfClosing = ""] = parts;
    const tagName = name.toLowerCase();
    const attributes = parseAttributes(body);
    if (tagName === "link") return "";
    if (tagName === "meta" && !attributes.some((a) => a.name.toLowerCase() === "charset")) return "";

    let changed = false;
    const kept: string[] = [];
    for (const attribute of attributes) {
      const value = this.attribute(tagName, attribute);
      if (value !== attribute.value) changed = true;
      if (value === null) continue;
      kept.push(value === attribute.value ? attribute.raw : serialise(attribute, value));
    }
    if (!changed) return tag;
    return `<${name}${kept.map((a) => ` ${a}`).join("")}${selfClosing}>`;
  }

  /** The attribute's new value: unchanged, replaced, or null to drop the attribute. */
  private attribute(tagName: string, { name, value }: Attribute): string | null | undefined {
    const attributeName = name.toLowerCase();
    if (value === undefined) return value;
    if (REMOVED_ATTRIBUTES.has(attributeName)) return null;
    if (attributeName.startsWith("data-") && attributeName !== "data-testid" && URL_OR_URN.test(value)) return null;
    if (attributeName === "style") return scrubStyle(value);
    if (isImageSource(tagName, attributeName)) return PIXEL;
    if (URL_ATTRIBUTES.has(attributeName) && isForeignUrl(value)) return BLANK;
    return this.text(value, INTERFACE_ATTRIBUTES.has(attributeName) ? "interface" : "attribute");
  }

  private replaceLinks(value: string): string {
    return value.replace(
      LINK,
      (_whole, kind: Kind | undefined, id: string | undefined, path: string | undefined, encodedKind: Kind | undefined, encodedId: string | undefined) => {
        if (kind !== undefined && id !== undefined) return `/${kind}/${this.linkStandIn(kind, id)}${path ?? ""}`;
        if (encodedKind === undefined || encodedId === undefined) return _whole;
        return `%2F${encodedKind}%2F${this.linkStandIn(encodedKind, decodeOnce(encodedId))}`;
      },
    );
  }

  private linkStandIn(kind: Kind, id: string): string {
    return `${LINK_PREFIX[kind]}-${this.links[kind].of(decodeOnce(id).toLowerCase())}`;
  }
}

type Kind = keyof typeof LINK_PREFIX;
/** Text content, a content attribute value (aria-label, href...), or an interface attribute value (class...). */
type ValueKind = "text" | "attribute" | "interface";

function decodeFully(value: string): string {
  let current = value;
  for (let decoded = decodeOnce(current); decoded !== current; decoded = decodeOnce(current)) current = decoded;
  return current;
}

function countDigits(value: string): number {
  return value.replace(/\D/g, "").length;
}

/** Hex, or base64 mixing upper case, lower case and digits: not a word or a class name. */
function isOpaque(run: string): boolean {
  const body = run.replace(/=+$/, "");
  if (/^[0-9a-fA-F]+$/.test(body)) return true;
  return /[A-Z]/.test(body) && /[a-z]/.test(body) && /\d/.test(body);
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function removeStructure(
  whole: string,
  emptied: string | undefined,
  emptiedAttributes: string | undefined,
  codeAttributes: string | undefined,
  codeContent: string | undefined,
): string {
  if (emptied !== undefined) return `<${emptied}${emptiedAttributes ?? ""}></${emptied}>`;
  if (codeContent === undefined) return ""; // a comment
  const content = codeContent.replace(/<!--|-->/g, "").trim();
  if (content.startsWith("{") || content.startsWith("[")) return "";
  return `<code${codeAttributes ?? ""}>${codeContent.replace(STRUCTURE, removeStructure)}</code>`;
}

function parseAttributes(body: string): Attribute[] {
  const attributes: Attribute[] = [];
  for (const match of body.matchAll(ATTRIBUTE)) {
    const [raw, name = "", doubleQuoted, singleQuoted, unquoted] = match;
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
    attributes.push({ name, value: doubleQuoted ?? singleQuoted ?? unquoted, quote, raw });
  }
  return attributes;
}

function serialise(attribute: Attribute, value: string | undefined): string {
  if (value === undefined) return attribute.name;
  const quote = attribute.quote === "" ? '"' : attribute.quote;
  return `${attribute.name}=${quote}${value}${quote}`;
}

function isImageSource(tagName: string, attributeName: string): boolean {
  if (attributeName === "poster") return true;
  if (tagName === "img") return attributeName === "src";
  if (tagName === "image") return attributeName === "href" || attributeName === "xlink:href";
  return false;
}

/** True for absolute URLs on LinkedIn's CDNs or on any host that is not LinkedIn. */
function isForeignUrl(value: string): boolean {
  const host = ABSOLUTE_URL.exec(value)?.[1]?.toLowerCase();
  if (host === undefined) return false;
  return !/(?:^|\.)linkedin\.com$/.test(host);
}

/** Drops declarations that load an image; null when nothing is left. */
function scrubStyle(style: string): string | null {
  if (!/url\s*\(/i.test(style)) return style;
  const declarations = style
    .split(/;(?![^(]*\))/)
    .filter((declaration) => !/url\s*\(/i.test(declaration))
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== "");
  return declarations.length === 0 ? null : declarations.join("; ");
}

interface KnownStrings {
  replace(value: string): string;
}

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";
/** Lines of a text shorter than this are not replaced on their own. */
const MIN_LINE = 8;
const MIN_NAME_TOKEN = 3;
const STAND_IN_WORDS = new Set(["person", "company"]);

/**
 * Builds the known-string replacer: full strings longest first, then
 * first and last name tokens as standalone words. Matching is tolerant of HTML
 * entities, curly apostrophes and non-breaking spaces.
 */
function knownStrings({ names = [], companies = [], texts = [] }: Sensitive): KnownStrings {
  const full = new Map<string, string>();
  const tokens = new Map<string, string>();
  const add = (map: Map<string, string>, value: string, standIn: string) => {
    const key = normalise(value);
    if (key !== "" && !map.has(key)) map.set(key, standIn);
  };
  unique(names).forEach((name, i) => {
    add(full, name, `Person ${i + 1}`);
    const words = normalise(name).split(" ");
    for (const word of [words[0], words.at(-1)]) {
      if (word !== undefined && isNameToken(word)) add(tokens, word, `Person ${i + 1}`);
    }
  });
  unique(companies).forEach((company, i) => add(full, company, `Company ${i + 1}`));
  for (const text of unique(texts)) {
    add(full, text, filler(normalise(text).length));
    for (const line of text.split(/\n+/)) {
      if (normalise(line).length >= MIN_LINE) add(full, line, filler(normalise(line).length));
    }
  }
  const fullMatcher = new Matcher(full, "[\\p{L}\\p{N}]");
  const tokenMatcher = new Matcher(tokens, "[\\p{L}\\p{N}_]");
  return { replace: (value) => tokenMatcher.replace(fullMatcher.replace(value)) };
}

interface Entry {
  readonly pattern: RegExp;
  readonly standIn: string;
}

/**
 * Replaces normalised keys where they appear in raw HTML, longest first, never inside a
 * longer word. Keys are bucketed by first character so each position tries only a few.
 */
class Matcher {
  private readonly buckets = new Map<string, Entry[]>();
  private readonly endsInWord: RegExp;
  private readonly isWord: RegExp;

  constructor(standIns: ReadonlyMap<string, string>, wordChar: string) {
    this.endsInWord = new RegExp(`${wordChar}$`, "u");
    this.isWord = new RegExp(`^${wordChar}$`, "u");
    const sorted = [...standIns].sort(([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, standIn] of sorted) {
      const first = String.fromCodePoint(key.codePointAt(0) ?? 0);
      const after = this.endsInWord.test(key) ? `(?!${wordChar})` : "";
      const bucket = this.buckets.get(first) ?? [];
      bucket.push({ pattern: new RegExp(`${tolerant(key)}${after}`, "uy"), standIn });
      this.buckets.set(first, bucket);
    }
  }

  replace(value: string): string {
    if (this.buckets.size === 0) return value;
    let out = "";
    let last = 0;
    let i = 0;
    while (i < value.length) {
      const [char, length] = readChar(value, i);
      const bucket = this.buckets.get(char);
      const startsWord = !this.isWord.test(char) || !this.endsInWord.test(value.slice(Math.max(0, i - 2), i));
      const match = bucket !== undefined && startsWord ? matchAt(bucket, value, i) : undefined;
      if (match === undefined) {
        i += length;
        continue;
      }
      out += value.slice(last, i) + match.standIn;
      i += match.length;
      last = i;
    }
    return out + value.slice(last);
  }
}

function matchAt(bucket: readonly Entry[], value: string, index: number): { standIn: string; length: number } | undefined {
  for (const { pattern, standIn } of bucket) {
    pattern.lastIndex = index;
    const match = pattern.exec(value);
    if (match !== null) return { standIn, length: match[0].length };
  }
  return undefined;
}

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-z]+));/y;

/** The normalised character at `index` (an entity counts as one) and its raw length. */
function readChar(value: string, index: number): [string, number] {
  if (value[index] === "&") {
    ENTITY.lastIndex = index;
    const entity = ENTITY.exec(value);
    if (entity !== null) return [foldChar(decodeEntity(entity[0], entity[1], entity[2], entity[3])), entity[0].length];
  }
  const char = String.fromCodePoint(value.codePointAt(index) ?? 0);
  return [foldChar(char), char.length];
}

function foldChar(char: string): string {
  if (/[‘’ʼ]/.test(char)) return "'";
  if (/[“”]/.test(char)) return '"';
  return /^\s$/.test(char) ? " " : char;
}

function decodeEntity(entity: string, decimal?: string, hex?: string, named?: string): string {
  const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? parseInt(hex, 16) : undefined;
  if (code !== undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  return (named !== undefined ? NAMED_ENTITIES[named] : undefined) ?? entity;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalise(value);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNameToken(word: string): boolean {
  const letters = word.match(/\p{L}/gu)?.length ?? 0;
  return /^\p{L}[\p{L}'.-]*$/u.test(word) && letters >= MIN_NAME_TOKEN && !STAND_IN_WORDS.has(word.toLowerCase());
}

/** Lorem words of exactly `length` characters. */
function filler(length: number): string {
  let out = LOREM;
  while (out.length < length) out += ` ${LOREM}`;
  out = out.slice(0, length);
  return out.endsWith(" ") ? `${out.slice(0, -1)}a` : out;
}

const WHITESPACE = "(?:\\s|&nbsp;|&#0*160;|&#[xX]0*[aA]0;)+";
const CHARACTER_FORMS: Readonly<Record<string, string>> = {
  " ": WHITESPACE,
  "'": "(?:['\u2018\u2019\u02bc]|&#0*39;|&#[xX]0*27;|&apos;|&rsquo;|&lsquo;|&#0*8217;|&#[xX]0*2019;)",
  '"': "(?:[\"\u201c\u201d]|&quot;|&#0*34;|&#[xX]0*22;|&ldquo;|&rdquo;)",
  "&": "(?:&amp;|&#0*38;|&#[xX]0*26;|&)",
  "<": "(?:<|&lt;)",
  ">": "(?:>|&gt;)",
};

/** A regex source matching a normalised string as it may appear in raw HTML. */
function tolerant(key: string): string {
  let out = "";
  for (const char of key) {
    const form = CHARACTER_FORMS[char];
    if (form !== undefined) {
      out += form;
      continue;
    }
    const escaped = char.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
    const code = char.codePointAt(0) ?? 0;
    if (code < 128) {
      out += escaped;
      continue;
    }
    const hex = code.toString(16).replace(/[a-f]/g, (h) => `[${h}${h.toUpperCase()}]`);
    out += `(?:${escaped}|&#0*${code};|&#[xX]0*${hex};)`;
  }
  return out;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
};

/** Decodes the entities `tolerant` knows, folds quotes and whitespace, trims. */
function normalise(value: string): string {
  return value
    .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-z]+));/g, decodeEntity)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
