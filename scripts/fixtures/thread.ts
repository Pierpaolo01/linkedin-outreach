/**
 * `npx tsx scripts/fixtures/thread.ts [<capture> <fixture>]`
 *
 * Turns a messaging capture (real people's private messages, git-ignored) into a committed fixture:
 * by default `captures/messaging.html` → `fixtures/messaging/inbox-inmail-en.html`; also
 * `captures/inv-thread-direct.html` → `fixtures/messaging/two-way-en.html`.
 *
 * The parsers find the sensitive strings: every name in the list and the open conversation, the
 * user's own name ("Me" menu), the participant's headline, InMail subjects, message bodies and
 * snippets (without their "You:" / "<name>:" prefix, which is interface). Message bodies are also
 * collected text node by text node, because inline markup (<strong>, <em>, links) splits a sentence
 * across several nodes. Member URN ids ("ACoAA…") are renumbered first, attribute copies of message
 * bodies are blanked, then `scrubHtml` replaces the rest. The script re-parses the fixture, fails if
 * any parsed count or sender differs, and fails if any name, name word, text, sentence or run of six
 * words of a message body, or id is still anywhere in the fixture (text, aria-label, title, alt).
 * It prints counts only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { thread as threadSelectors } from "../../src/linkedin/parse/selectors.thread";
import { parseConversationList, parseThread, type ConversationSummary, type Thread } from "../../src/linkedin/parse/thread";
import { scrubHtml, type Sensitive } from "../../src/linkedin/scrub";

/** Defaults to the inbox capture; `npx tsx scripts/fixtures/thread.ts <capture> <fixture>` scrubs another one. */
const [CAPTURE = "captures/messaging.html", FIXTURE = "fixtures/messaging/inbox-inmail-en.html"] = process.argv.slice(2);
/** Shorter text-node fragments are words or punctuation, not sentences; replacing them would also hit interface wording. */
const MIN_FRAGMENT = 8;
/** Sentences of a message body shorter than this are not checked on their own ("Hi X,"). */
const MIN_SENTENCE = 12;
const MEMBER_URN = /ACoAA[A-Za-z0-9_-]+/g;

const repoPath = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

interface Parsed {
  readonly thread: Thread;
  readonly list: readonly ConversationSummary[];
}

function parseAll(html: string): Parsed {
  return { thread: parseThread(html), list: parseConversationList(html) };
}

/** Text nodes under the elements matched by `selector`, whitespace collapsed. */
function textNodes(root: HTMLElement, selector: string): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) out.push(node.text.replace(/\s+/g, " ").trim());
    else node.childNodes.forEach(walk);
  };
  root.querySelectorAll(selector).forEach(walk);
  return out.filter((text) => text.length >= MIN_FRAGMENT);
}

/** The snippet without a "You:" / "<first name>:" prefix, so the prefix wording survives in the fixture. */
function snippetBody(summary: ConversationSummary): string {
  return summary.snippetSender === null ? summary.snippet : summary.snippet.replace(/^[^:]{1,40}:\s*/, "");
}

function sensitiveFrom(capture: string, { thread, list }: Parsed): Required<Sensitive> {
  const root = parse(capture);
  const userName = root.querySelector(threadSelectors.mePhoto)?.getAttribute("alt")?.trim() ?? "";
  // The user's name may carry an emoji after the surname; the bare name is scrubbed too.
  const bareUserName = userName.replace(/[^\p{L}\p{M}' .-]/gu, " ").replace(/\s+/g, " ").trim();
  const names = new Set(
    [thread.participant.fullName, userName, bareUserName, ...list.map((c) => c.participantName), ...thread.messages.map((m) => m.senderName)].filter(
      (name) => name !== "",
    ),
  );
  const texts = new Set<string>();
  const addText = (text: string | null) => {
    if (text !== null && text.length >= 3 && /\p{L}/u.test(text)) texts.add(text);
  };
  addText(thread.participant.headline);
  for (const message of thread.messages) {
    addText(message.subject);
    addText(message.text);
  }
  for (const summary of list) addText(snippetBody(summary));
  for (const fragment of [
    ...textNodes(root, `${threadSelectors.pane} ${threadSelectors.body}`),
    ...textNodes(root, `${threadSelectors.pane} ${threadSelectors.subject}`),
  ]) {
    addText(fragment);
  }
  // Page inboxes (company pages the user manages) show the page's name as "<name> picture" and as text.
  const pages = new Set(
    root
      .querySelectorAll('img[alt$=" picture"]')
      .map((img) => (img.getAttribute("alt") ?? "").replace(/ picture$/, "").trim())
      .filter((name) => name !== "" && !names.has(name)),
  );
  return { names: [...names], companies: [...pages], texts: [...texts] };
}

const LOREM = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";

function filler(length: number): string {
  let out = LOREM;
  while (out.length < length) out += ` ${LOREM}`;
  return out.slice(0, length);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Some attribute copies are encoded twice (`&amp;#39;`), so decode until nothing changes. */
function decodeFully(value: string): string {
  let previous = value;
  for (;;) {
    const next = decodeEntities(previous);
    if (next === previous) return next;
    previous = next;
  }
}

/**
 * LinkedIn repeats a whole message body, flattened, inside attributes (the hidden "Options for the
 * message from <name>: <body>" label of each message). Flattening joins list items and lines in ways no
 * collected string matches, so any attribute value holding a piece of a body keeps the part before
 * that piece (interface wording and a name, which `scrubHtml` then handles) and loses the rest.
 */
function blankBodyCopies(html: string, fragments: readonly string[]): { html: string; blanked: number } {
  const needles = fragments.map(fold).filter((needle) => needle.length >= MIN_FRAGMENT);
  let blanked = 0;
  const out = html.replace(/(\s[^\s"'>/=]+\s*=\s*")([^"]*)(")/g, (whole, start: string, raw: string, end: string) => {
    const value = decodeFully(raw).replace(/\s+/g, " ");
    const lower = fold(value);
    const at = Math.min(...needles.map((needle) => lower.indexOf(needle)).filter((index) => index >= 0));
    if (!Number.isFinite(at)) return whole;
    blanked += 1;
    const kept = value.slice(0, at) + filler(value.length - at);
    return `${start}${kept.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}${end}`;
  });
  return { html: out, blanked };
}

/** Every piece of message content a leak check or the attribute pass should look for. */
function bodyFragments(capture: string, { thread }: Parsed): string[] {
  const root = parse(capture);
  return [
    ...thread.messages.flatMap((m) => [m.subject ?? "", ...m.text.split("\n")]),
    ...textNodes(root, `${threadSelectors.pane} ${threadSelectors.body}`),
    ...textNodes(root, `${threadSelectors.pane} ${threadSelectors.subject}`),
  ].filter((fragment) => fold(fragment).length >= MIN_FRAGMENT);
}

/** Runs of this many consecutive words of a message body must not appear anywhere in the fixture. */
const WORD_WINDOW = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The fixture as plain lower-case text with entities decoded, tags removed and whitespace collapsed. */
function readable(html: string): { withTags: string; withoutTags: string } {
  const decode = (value: string) =>
    value
      .replace(/&(?:#39|#x27|apos|rsquo|lsquo);/g, "'")
      .replace(/&(?:quot|ldquo|rdquo);/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"');
  // Twice: LinkedIn encodes some attribute copies twice (`&amp;#39;`).
  const fold = (value: string) => decode(decode(value)).toLowerCase().replace(/\s+/g, " ");
  return { withTags: fold(html), withoutTags: fold(html.replace(/<[^>]*>/g, " ")) };
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/** Collected strings still present in the fixture, as "<kind> #<n>" labels (never the strings themselves). */
function leaks(capture: string, fixture: string, sensitive: Required<Sensitive>, parsed: Parsed): string[] {
  const found: string[] = [];
  const { withTags, withoutTags } = readable(fixture);
  const contains = (value: string) => {
    const needle = fold(value);
    return needle !== "" && (withTags.includes(needle) || withoutTags.includes(needle));
  };
  sensitive.names.forEach((name, i) => contains(name) && found.push(`name #${i + 1}`));
  sensitive.companies.forEach((name, i) => contains(name) && found.push(`page name #${i + 1}`));
  const nameWords = [...new Set(sensitive.names.flatMap((name) => name.split(/\s+/)).filter((word) => /^\p{L}{3,}$/u.test(word)))];
  nameWords.forEach((word, i) => {
    // Case-sensitive whole word: a capitalised name, not the same letters inside interface wording.
    if (new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "u").test(fixture.replace(/<[^>]*>/g, " ")) || attributeValues(fixture).some((v) => new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "u").test(v))) {
      found.push(`name word #${i + 1}`);
    }
  });
  sensitive.texts.forEach((text, i) => contains(text) && found.push(`text #${i + 1}`));
  parsed.thread.messages.forEach((message, m) => {
    const words = fold(`${message.subject ?? ""} ${message.text}`).split(" ").filter(Boolean);
    let windows = 0;
    for (let i = 0; i + WORD_WINDOW <= words.length; i += 1) {
      const window = words.slice(i, i + WORD_WINDOW).join(" ");
      if (withTags.includes(window) || withoutTags.includes(window)) windows += 1;
    }
    if (windows > 0) found.push(`message ${m + 1}: ${windows} runs of ${WORD_WINDOW} words`);
    const sentences = `${message.subject ?? ""}\n${message.text}`.split(/(?<=[.!?:])\s+|\n+/).map((s) => s.trim());
    sentences.forEach((sentence, s) => {
      if (sentence.length >= MIN_SENTENCE && contains(sentence)) found.push(`message ${m + 1} sentence #${s + 1}`);
    });
  });
  const urns = [...new Set(capture.match(MEMBER_URN) ?? [])];
  urns.forEach((urn, i) => fixture.includes(urn) && found.push(`member urn #${i + 1}`));
  const vanityIds = [...new Set([...capture.matchAll(/"publicIdentifier":"([^"]+)"/g)].map((m) => m[1] ?? ""))].filter(Boolean);
  vanityIds.forEach((id, i) => fixture.toLowerCase().includes(id.toLowerCase()) && found.push(`public id #${i + 1}`));
  return found;
}

function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s[^\s"'>/=]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** The parsed facts the fixture must keep: counts, senders, kinds, unread flags. */
function shape({ thread, list }: Parsed): string {
  return JSON.stringify({
    kind: thread.kind,
    participantLinked: thread.participant.publicId !== null,
    senders: thread.messages.map((m) => m.sender),
    list: list.map((c) => [c.kind, c.unread, c.snippetSender]),
  });
}

function main(): void {
  const capture = readFileSync(repoPath(CAPTURE), "utf8");
  const parsed = parseAll(capture);
  const sensitive = sensitiveFrom(capture, parsed);

  const urns = [...new Set(capture.match(MEMBER_URN) ?? [])];
  const numbering = new Map(urns.map((urn, index) => [urn, `ACoAAmember${index + 1}`]));
  const renumbered = capture.replace(MEMBER_URN, (urn) => numbering.get(urn) ?? urn);
  const { html: withoutBodyCopies, blanked } = blankBodyCopies(renumbered, bodyFragments(capture, parsed));
  const fixture = scrubHtml(withoutBodyCopies, sensitive);

  const reparsed = parseAll(fixture);
  const leaked = leaks(capture, fixture, sensitive, parsed);
  const target = repoPath(FIXTURE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fixture);

  const same = shape(parsed) === shape(reparsed);
  console.log(
    `${FIXTURE}: capture ${parsed.thread.messages.length} messages (${parsed.thread.kind}), ${parsed.list.length} conversations; ` +
      `fixture ${reparsed.thread.messages.length} messages (${reparsed.thread.kind}), ${reparsed.list.length} conversations; ` +
      `same senders, kinds and flags: ${same ? "yes" : "NO"}`,
  );
  console.log(
    `scrubbed ${sensitive.names.length} names, ${sensitive.texts.length} texts, ${urns.length} member ids, ${blanked} attribute copies of message bodies; leaks: ${leaked.length === 0 ? "none" : leaked.join(", ")}`,
  );
  if (!same || leaked.length > 0) {
    console.error("fixture check failed: fix the scrub before committing");
    process.exitCode = 1;
  }
}

main();
