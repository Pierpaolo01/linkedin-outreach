import { useEffect, useState, type ReactNode } from "react";
import type { CampaignStatus, EventLevel } from "../db/schema";
import { CAMPAIGN_STATUS_DOT, CAMPAIGN_STATUS_LABEL, formatScore, scoreTone } from "./format";
import { PAUSABLE, plainMessage } from "./words";

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

/** A button on a Stop Red surface (the safety-stop banner, the red session card). */
export const ON_RED_BUTTON = "btn border-error-content/40 bg-error-content text-error";

// ------------------------------------------------------------ errors and notices

/** The server's (or the form's) message for one field, under it. */
export function FieldError({ id, message }: { readonly id?: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="mt-1 text-sm text-error" data-testid="field-error">
      {message}
    </p>
  );
}

/** What went wrong when the user's action failed (a save, a pause, a decision). Nothing when there is no message. */
export function ActionError({ message, className, testId }: { readonly message: string | undefined; readonly className?: string; readonly testId?: string }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className={`rounded-box bg-error/10 px-3 py-2 text-sm text-error ${className ?? ""}`} data-testid={testId}>
      {message}
    </p>
  );
}

/** The box a page or section shows when its data could not load, with a way to try again. */
export function LoadError(props: { readonly what: string; readonly message: string; readonly onRetry: () => void; readonly className?: string }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-3 rounded-box border border-error/40 bg-error/5 px-4 py-4 ${props.className ?? "mt-5"}`}>
      <p className="text-error">
        Could not load {props.what}: {props.message}
      </p>
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
 * No stripe and no amber: amber means "waits for you", and a solid red is the safety stop.
 */
export function ActivityMessage({ level, message }: { readonly level: EventLevel; readonly message: string }) {
  return (
    <span className={level === "error" ? "text-error" : ""}>
      {level === "warning" && <span className="mr-1.5 font-semibold">Warning:</span>}
      {level === "error" && <span className="mr-1.5 font-semibold">Error:</span>}
      {plainMessage(message)}
    </span>
  );
}

// ------------------------------------------------------------ campaign status and scores

/** True when a safety stop has halted this campaign: it would be working otherwise. */
export function haltedBy(status: CampaignStatus, safetyStop: boolean): boolean {
  return safetyStop && PAUSABLE.has(status);
}

/** A campaign's status as the user reads it. */
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

const SCORE_CHIP = {
  high: "bg-score-high text-primary",
  mid: "bg-score-mid text-score-mid-content",
  low: "bg-base-200 text-base-content",
} as const;
const SCORE_SIZE = { sm: "size-7", lg: "size-10 text-lg" } as const;

/** A prospect's score in a square chip: mint from 7, sand from 5, quiet below or when not scored. */
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

// ------------------------------------------------------------ controls

/** A labelled field: the label, an optional line on what it is for, the control, its error. */
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
      {props.hint !== undefined && <p className="text-sm text-muted">{props.hint}</p>}
      <div className="mt-1.5">{props.children}</div>
      <FieldError message={props.error} />
    </div>
  );
}

/** An on/off switch with its label and what it does. */
export function SwitchRow(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        className="toggle toggle-primary mt-0.5 shrink-0"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={props.id} className="font-medium">
          {props.label}
        </label>
        {props.hint !== undefined && <div className="text-sm text-muted">{props.hint}</div>}
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


