import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CampaignStatus, EventLevel } from "../db/schema";
import { CAMPAIGN_STATUS_DOT, CAMPAIGN_STATUS_LABEL, formatScore, scoreTone, withStop } from "./format";
import { filledSegments } from "./filled";
import { IconChevron, IconWarning } from "./icons";
import { failure, PAUSABLE, plainMessage, type Failure, type Said } from "./words";

/**
 * The pieces every page shares, so each look is decided in one place: the button recipes, the three
 * error treatments (a field's line, a failed action, a failed load), notices, a campaign's status line,
 * score chips, the campaign filter, a switch row, paging and a debounced value.
 */

// ------------------------------------------------------------ buttons

/** The secondary button: Desk Paper with a Hairline Sage border. Add the size (`btn-sm`, `btn-xs`) where it is used. */
export const SECONDARY_BUTTON = "btn border-base-300 bg-base-100 hover:not-disabled:bg-base-200";

/** A quiet text button: no fill and no border, for an action that must not compete with what sits beside it. */
export const QUIET_BUTTON = "btn btn-ghost font-medium text-muted";

/**
 * Added to the secondary button for Pause on a campaign a safety stop has already halted: its words step back to the
 * muted tone, while its border keeps it a button that can be pressed (pausing it still holds it after a resume).
 */
export const HALTED_PAUSE = "text-muted";

/** A button on a Stop Red surface (the safety-stop banner, the red session card). */
export const ON_RED_BUTTON = "btn border-error-content/40 bg-error-content text-error";

// ------------------------------------------------------------ errors and notices

/** The id of the error line under the control `controlId`. */
const errorIdOf = (controlId: string) => `${controlId}-error`;

/** The id of the line that says what the control `controlId` (or a group of controls) is for: give it to that line. */
export const hintIdOf = (controlId: string) => `${controlId}-hint`;

/** What describes a control: its error line first, while it shows, then the line on what it is for. */
function describedBy(errorId: string | undefined, hintId: string | undefined): { readonly "aria-describedby"?: string } {
  const ids = [errorId, hintId].filter((id) => id !== undefined);
  return ids.length === 0 ? {} : { "aria-describedby": ids.join(" ") };
}

/**
 * What a control carries: marked invalid when it has an error, and described by its error line (`FieldError` with the
 * same id) and then by its hint (`hint`, the id of the line on what it is for, usually `hintIdOf(controlId)`).
 */
export function errorProps(controlId: string, message: string | undefined, options: { readonly hint?: string | undefined } = {}) {
  return {
    ...(message === undefined ? {} : { "aria-invalid": true as const }),
    ...describedBy(message === undefined ? undefined : errorIdOf(controlId), options.hint),
  };
}

/**
 * For one control of a group whose error line is `groupId`'s (a range, a time pair): points at that line while it
 * shows, then at the line on what the control is for (`hint`), if it has one.
 */
export function describedByError(groupId: string, message: string | undefined, options: { readonly hint?: string | undefined } = {}) {
  return describedBy(message === undefined ? undefined : errorIdOf(groupId), options.hint);
}

/**
 * The server's (or the form's) message for one field, under it, ending as a sentence (the server's rules write some
 * without a full stop). Pass the control's id so the control can point at it.
 */
export function FieldError({ controlId, message }: { readonly controlId?: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={controlId === undefined ? undefined : errorIdOf(controlId)} role="alert" className="mt-1 text-sm text-error" data-testid="field-error">
      {withStop(message)}
    </p>
  );
}

/**
 * A live region that is always in the page, so what appears in it is read out: the visible result of an action
 * (`children`, shown only once there is one), and `message` for a screen reader alone. It draws no box of its own,
 * so an empty one takes no room in a list or a row.
 */
export function Announce({ message, children }: { readonly message?: string | undefined; readonly children?: ReactNode }) {
  return (
    <div role="status" className="contents">
      {children}
      {message !== undefined && <span className="sr-only">{message}</span>}
    </div>
  );
}

/** What was said about a failure ("What the app said: …"), set apart from the app's own words and quieter. */
function FailureDetail({ detail, onRed = false }: { readonly detail: string | undefined; readonly onRed?: boolean }) {
  if (detail === undefined) return null;
  return <p className={`mt-0.5 ${onRed ? "text-error-content/90" : "text-muted"}`}>{detail}</p>;
}

/**
 * The words of a failed action, the one failure pattern: the app's sentence (what failed, what state things are in,
 * what to do) in Stop Red, then what was said, apart and muted. On a Stop Red surface (`onRed`: the session banner)
 * the sentence is light ink at 500 and the detail light ink at 90%. `ActionError` draws it in its box.
 */
export function FailureWords({ message, onRed = false }: { readonly message: string | Failure; readonly onRed?: boolean }) {
  const { text, detail } = typeof message === "string" ? { text: message, detail: undefined } : message;
  return (
    <>
      <p className={onRed ? "font-medium" : "text-error"}>{text}</p>
      <FailureDetail detail={detail} onRed={onRed} />
    </>
  );
}

/**
 * What went wrong when the user's action failed (a save, a pause, a decision). Nothing when there is no message.
 * A `Failure` says what failed, what state things are in and what to do, with the server's words apart under it.
 * With an `id` it can take the focus from the script (`focusInView`), for a summary far from the button that failed;
 * with `takeFocus` it takes the focus itself each time a new message appears (the button that failed was disabled
 * while it worked, so the focus had nowhere to stay). `announce={false}` inside a live region that already says it
 * (a save bar's status line), so it is not read twice. Its corners are a field's (6px), as a `Notice`'s are.
 */
export function ActionError({
  message,
  className,
  testId,
  id,
  takeFocus = false,
  announce = true,
}: {
  readonly message: string | Failure | undefined;
  readonly className?: string;
  readonly testId?: string;
  readonly id?: string;
  readonly takeFocus?: boolean;
  readonly announce?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (takeFocus && message !== undefined && box.current !== null) focusInView(box.current);
  }, [takeFocus, message]);
  if (message === undefined) return null;
  return (
    <div
      ref={box}
      id={id}
      tabIndex={id === undefined && !takeFocus ? undefined : -1}
      role={announce ? "alert" : undefined}
      className={`rounded-field bg-error/10 px-3 py-2 text-sm ${className ?? ""}`}
      data-testid={testId}
    >
      <FailureWords message={message} />
    </div>
  );
}

/** The box a page or section shows when its data could not load, with a way to try again. */
export function LoadError(props: { readonly what: string; readonly error: Said; readonly onRetry: () => void; readonly className?: string }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-3 rounded-box border border-error/40 bg-error/5 p-4 ${props.className ?? ""}`}>
      <div className="min-w-0">
        <p className="text-error">Could not load {props.what}. Nothing was changed; press Try again.</p>
        <FailureDetail detail={failure("", props.error).detail} />
      </div>
      <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}

const NOTICE_TONE = {
  /** Someone or something waits on the user: a held person, a text that cannot be written yet. */
  waits: "bg-accent/20",
  /** Plain information the user should know before acting. */
  note: "bg-base-200",
} as const;

/** A short notice inside a page: why something is held, or what an action will affect. */
export function Notice(props: { readonly tone: keyof typeof NOTICE_TONE; readonly children: ReactNode; readonly className?: string; readonly role?: "alert" }) {
  return (
    <p role={props.role} className={`rounded-field px-3 py-2 ${NOTICE_TONE[props.tone]} ${props.className ?? ""}`}>
      {props.children}
    </p>
  );
}

/**
 * One line of what the app did. A warning or an error leads with its word at 600; an error is Stop Red text.
 * A safety stop's line already leads with "Safety stop:", so it takes no "Error:" before it.
 * No stripe and no amber: amber means "waits for you", and a solid red is the safety stop.
 */
export function ActivityMessage(props: {
  readonly level: EventLevel;
  readonly message: string;
  /** The name of the line's campaign, when known. */
  readonly campaign?: string | undefined;
  /** The row shows the campaign beside the message (the activity log), so the message does not name it again. */
  readonly campaignShown?: boolean;
}) {
  const { level } = props;
  const text = plainMessage(props.message, { campaign: props.campaign, campaignShown: props.campaignShown === true });
  return (
    <span className={level === "error" ? "text-error" : ""}>
      {level === "warning" && <span className="mr-1.5 font-semibold">Warning:</span>}
      {level === "error" && !text.startsWith("Safety stop:") && <span className="mr-1.5 font-semibold">Error:</span>}
      {text}
    </span>
  );
}

/**
 * The mark that lets a warning or an error line be found at a glance in a log: an Ink triangle with "!" for a warning
 * (its own shape: a ring is a campaign that is not working), a solid red dot for an error, nothing for information.
 * Not amber and not a stripe; the words of the line carry the level, so it is hidden from screen readers.
 */
export function LevelMark({ level }: { readonly level: EventLevel }) {
  if (level === "info") return null;
  if (level === "warning") return <IconWarning className="size-3.5 shrink-0 text-base-content" testId="level-mark" />;
  return <span className="status status-error shrink-0" aria-hidden="true" data-testid="level-mark" />;
}

/**
 * A text as it will be (or was) sent, with the words its variables filled in for this person at 500, so the fixed words
 * and the personal ones read apart. Read from the template's `{{variable}}` positions (`filledSegments`), so a fixed
 * word that happens to equal one of the person's values stays plain. Plain throughout when the template is unknown or
 * the text does not follow it (a template edited after the text was sent).
 */
export function FilledText({ text, template }: { readonly text: string; readonly template: string | null | undefined }) {
  const segments = template === null || template === undefined ? null : filledSegments(template, text);
  if (segments === null) return <>{text}</>;
  return (
    <>
      {segments.map((segment, i) =>
        segment.filled ? (
          <span key={i} className="font-medium">
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

// ------------------------------------------------------------ page structure

/**
 * A label and value list (`dl`) that is two columns from 640px and stacked below it. Stacked, each label sits 2px
 * over its value and the next label 12px (`group`) under it, so the pairs read as pairs. The label column is 13rem,
 * and 16rem from 1280px, where the value column has room to spare and the longest label ("Withdraw an unaccepted
 * invite after") fits on one line. Put `DEF_TERM` on every `dt`.
 */
export const DEF_LIST = "grid gap-x-6 gap-y-0.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-y-2 xl:grid-cols-[16rem_minmax(0,1fr)]";
export const DEF_TERM = "max-sm:not-first:mt-2.5";

/**
 * A folded part of a page: the summary line with the app's chevron (turned a quarter when open, as a person's row
 * does), never the browser's triangle. `summaryClassName` sets its size and colour.
 */
export function Disclosure(props: {
  readonly summary: ReactNode;
  readonly summaryClassName?: string;
  readonly className?: string;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <details className={`group ${props.className ?? ""}`} data-testid={props.testId}>
      <summary className={`inline-flex cursor-pointer list-none items-center gap-1 ${props.summaryClassName ?? ""}`}>
        {props.summary}
        <IconChevron className="size-3.5 shrink-0 transition-transform duration-(--duration-appear) ease-settle group-open:rotate-90" />
      </summary>
      {props.children}
    </details>
  );
}

/** The grey bar that holds a list's filters. Put it `group` (12px) above the list it filters. */
export const TOOLBAR = "flex flex-wrap items-center gap-x-4 gap-y-3 rounded-box bg-base-200 p-3";

/** A section's heading row: the heading, and at its right a link or button about the whole section. 12px above the content. */
export function SectionHead(props: { readonly id: string; readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="mb-group flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <h2 id={props.id} className="text-lg font-semibold">
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}

/**
 * What a list shows while it loads: a few bars of row height inside the list's own bordered box, so the page
 * keeps its shape when the rows arrive.
 */
export function SkeletonRows(props: {
  readonly rows?: number;
  /** The height of one bar; with the 12px above and below it, one row of the list. */
  readonly rowClassName?: string;
  readonly className?: string;
  /** Part of a larger loading view that says "Loading" once for all its blocks. */
  readonly quiet?: boolean;
}) {
  const { rows = 3, rowClassName = "h-10", quiet = false } = props;
  return (
    <div
      role={quiet ? undefined : "status"}
      aria-label={quiet ? undefined : "Loading"}
      aria-hidden={quiet || undefined}
      className={`flex flex-col divide-y divide-base-300 rounded-box border border-base-300 ${props.className ?? ""}`}
    >
      {Array.from({ length: rows }, (_, n) => (
        <div key={n} className="px-4 py-3">
          <div className={`skeleton w-full ${rowClassName}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * What a list says when it has nothing to show: one sentence at 500, a line on what will appear, maybe one action.
 * With an `id` it can take the focus from the script (after the last item of a list was decided and left).
 */
export function EmptyState(props: {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
  readonly id?: string;
}) {
  return (
    <div
      id={props.id}
      tabIndex={props.id === undefined ? undefined : -1}
      className={`rounded-box border border-base-300 p-card ${props.className ?? ""}`}
      data-testid={props.testId}
    >
      <p className="font-medium">{props.title}</p>
      {props.children !== undefined && <p className="mt-1 text-muted">{props.children}</p>}
      {props.action !== undefined && <div className="mt-4">{props.action}</div>}
    </div>
  );
}

// ------------------------------------------------------------ campaign status and scores

/** True when a safety stop has halted this campaign: it would be working otherwise. */
export function haltedBy(status: CampaignStatus, safetyStop: boolean): boolean {
  return safetyStop && PAUSABLE.has(status);
}

/** A campaign's status as the user reads it. */
export function statusLabel(status: CampaignStatus, safetyStop: boolean): string {
  return statusView(status, safetyStop).label;
}

function statusView(status: CampaignStatus, safetyStop: boolean): { readonly dot: string; readonly label: string } {
  if (haltedBy(status, safetyStop)) return { dot: "status-error", label: "Stopped by safety stop" };
  return { dot: CAMPAIGN_STATUS_DOT[status], label: CAMPAIGN_STATUS_LABEL[status] };
}

/** The status dot alone, where the words stand next to it in another form (the sidebar's campaign list). */
export function StatusDot({ status, safetyStop }: { readonly status: CampaignStatus; readonly safetyStop: boolean }) {
  const view = statusView(status, safetyStop);
  return <span className={`status ${view.dot}`} title={view.label} aria-hidden="true" />;
}

/** A campaign's status: the dot and its words. */
export function StatusLine(props: { readonly status: CampaignStatus; readonly safetyStop: boolean; readonly className?: string; readonly testId?: string }) {
  const view = statusView(props.status, props.safetyStop);
  return (
    <p className={`flex items-center gap-1.5 ${props.className ?? ""}`} data-testid={props.testId}>
      <span className={`status ${view.dot}`} aria-hidden="true" />
      {view.label}
    </p>
  );
}

/*
 * Three steps, filled to empty, none of them amber (amber means "waits for you") or red: mint from 7, a sage grey from
 * 5, a hairline outline below 5 or when not scored. The number is Ink or Desk Green on each (4.5:1 and over).
 */
const SCORE_CHIP = {
  high: "bg-score-high text-primary",
  mid: "bg-score-mid text-base-content",
  low: "bg-base-100 text-base-content ring-1 ring-score-low-edge ring-inset",
} as const;
const SCORE_SIZE = { sm: "size-7", lg: "size-10 text-lg" } as const;

/** A prospect's score in a square chip: mint from 7, sage grey from 5, an outline below or when not scored. */
export function ScoreChip({ score, size, role }: { readonly score: number | null; readonly size: keyof typeof SCORE_SIZE; readonly role?: "cell" }) {
  return (
    <span
      role={role}
      className={`nums inline-flex shrink-0 items-center justify-center rounded-field font-semibold ${SCORE_SIZE[size]} ${SCORE_CHIP[scoreTone(score)]}`}
      aria-label={score === null ? "Not scored" : `Score ${formatScore(score)} of 10`}
    >
      {score === null ? "–" : formatScore(score)}
    </span>
  );
}

// ------------------------------------------------------------ focus after a refusal

/** Moves the focus to `element` and brings it to the middle of the window (clear of a sticky bar); instantly under reduced motion. */
export function focusInView(element: HTMLElement) {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

/**
 * After a refused save: moves the focus to the first control `container` marked, in view (`focusInView`). Found from
 * the first error line with an id: of the controls that point at it (`aria-describedby`), the first that is itself
 * invalid (in a range, the box that is wrong, not its valid neighbour), else the first; or the first control of a
 * group (a fieldset) that does. False when nothing is marked, so the caller can bring its own message into view instead.
 */
export function focusFirstError(container: HTMLElement): boolean {
  const line = container.querySelector<HTMLElement>('[data-testid="field-error"][id]');
  if (line === null) return false;
  const pointing = `[aria-describedby~="${CSS.escape(line.id)}"]`;
  const owner = container.querySelector<HTMLElement>(`${pointing}[aria-invalid="true"]`) ?? container.querySelector<HTMLElement>(pointing);
  const control = owner?.matches("input, select, textarea, button") === true ? owner : owner?.querySelector<HTMLElement>("input, select, textarea, button");
  if (control === null || control === undefined) return false;
  focusInView(control);
  return true;
}

// ------------------------------------------------------------ controls

/**
 * A labelled field: the label, an optional line on what it is for, the control, its error. The control's id is
 * `htmlFor`; give it `errorProps(htmlFor, error, { hint: hintIdOf(htmlFor) })` (without `hint` when there is none) so it
 * is marked invalid and is described by its error line and its hint.
 */
export function Field(props: {
  readonly label: ReactNode;
  readonly htmlFor: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={props.className ?? ""}>
      <label htmlFor={props.htmlFor} className="block font-medium">
        {props.label}
      </label>
      {props.hint !== undefined && (
        <p id={hintIdOf(props.htmlFor)} className="text-sm text-muted">
          {props.hint}
        </p>
      )}
      <div className="mt-1.5">{props.children}</div>
      <FieldError controlId={props.htmlFor} message={props.error} />
    </div>
  );
}

/**
 * An on/off switch with its label and what it does. Below 1024px the whole row, at least 44px tall, is the
 * switch's target: the label's box is stretched over the row.
 */
export function SwitchRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** The switch's error, shown by the caller in a `FieldError` with the switch's id: the switch points at it. */
  readonly error?: string | undefined;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="relative flex items-start gap-3 max-lg:min-h-11">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        className={`toggle mt-0.5 shrink-0 ${props.error === undefined ? "toggle-primary" : "toggle-error"}`}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        {...errorProps(props.id, props.error, { hint: props.hint === undefined ? undefined : hintIdOf(props.id) })}
      />
      <div>
        <label htmlFor={props.id} className="font-medium max-lg:after:absolute max-lg:after:inset-0 max-lg:after:cursor-pointer">
          {props.label}
        </label>
        {props.hint !== undefined && (
          <div id={hintIdOf(props.id)} className="text-sm text-muted">
            {props.hint}
          </div>
        )}
      </div>
    </div>
  );
}

/** The campaign filter of a list: every campaign, or one. */
export function CampaignSelect(props: {
  readonly id?: string;
  readonly campaigns: readonly { readonly id: number; readonly name: string }[];
  readonly value: number | null;
  readonly onChange: (campaignId: number | null) => void;
}) {
  return (
    <select
      id={props.id}
      className="select select-sm w-auto max-w-64 bg-base-100"
      value={props.value ?? ""}
      onChange={(event) => props.onChange(event.target.value === "" ? null : Number(event.target.value))}
    >
      <option value="">All campaigns</option>
      {props.campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** "Showing 26 to 50 of 82", with Previous and Next. Hidden when everything fits on one page. */
export function Pager(props: { readonly page: number; readonly pageSize: number; readonly total: number; readonly onPage: (page: number) => void }) {
  const { page, pageSize, total } = props;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="Pages">
      <p className="nums text-sm text-muted" data-testid="pager-range">
        Showing {first} to {last} of {total}
      </p>
      {pages > 1 && (
        <div className="join">
          <button type="button" className={`${SECONDARY_BUTTON} join-item btn-sm`} disabled={page <= 1} onClick={() => props.onPage(page - 1)}>
            Previous
          </button>
          <span className="btn join-item btn-sm nums pointer-events-none border-base-300 bg-base-200 font-normal">
            Page {page} of {pages}
          </span>
          <button type="button" className={`${SECONDARY_BUTTON} join-item btn-sm`} disabled={page >= pages} onClick={() => props.onPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </nav>
  );
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}


