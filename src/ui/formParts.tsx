import { useEffect, useState, type ReactNode } from "react";

/** Small pieces the forms and lists share: a field's error line, a switch row, paging, a debounced value. */

/** The server's (or the form's) message for one field, under it. */
export function FieldError({ id, message }: { readonly id?: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="mt-1 text-sm text-error" data-testid="field-error">
      {message}
    </p>
  );
}

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
      {props.hint !== undefined && <p className="text-sm text-base-content/65">{props.hint}</p>}
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
  readonly tone?: "primary" | "warning";
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        className={`toggle mt-0.5 shrink-0 ${props.tone === "warning" ? "toggle-warning" : "toggle-primary"}`}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={props.id} className="font-medium">
          {props.label}
        </label>
        {props.hint !== undefined && <div className="text-sm text-base-content/65">{props.hint}</div>}
      </div>
    </div>
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
      <p className="nums text-sm text-base-content/65" data-testid="pager-range">
        Showing {first} to {last} of {total}
      </p>
      {pages > 1 && (
        <div className="join">
          <button type="button" className="btn join-item btn-sm border-base-300 bg-base-100" disabled={page <= 1} onClick={() => props.onPage(page - 1)}>
            Previous
          </button>
          <span className="btn join-item btn-sm nums pointer-events-none border-base-300 bg-base-200 font-normal">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn join-item btn-sm border-base-300 bg-base-100" disabled={page >= pages} onClick={() => props.onPage(page + 1)}>
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

/** The error box a page shows when its data could not load, with a way to try again. */
export function LoadError({ what, message, onRetry }: { readonly what: string; readonly message: string; readonly onRetry: () => void }) {
  return (
    <div role="alert" className="mt-5 flex flex-wrap items-center gap-3 rounded-box border border-error/40 bg-error/5 px-4 py-4">
      <p className="text-error">
        Could not load {what}: {message}
      </p>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
