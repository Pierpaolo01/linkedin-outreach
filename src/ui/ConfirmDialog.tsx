import { useEffect, useId, useRef, type ReactNode } from "react";
import { ActionError, SECONDARY_BUTTON } from "./formParts";

/**
 * A modal question with one action and a way out. Escape or the backdrop count as cancel, except while the action
 * runs (`busy`): then nothing closes it, so the action's failure is still shown where it was asked for.
 */
export function ConfirmDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "primary" | "error";
  readonly busy?: boolean;
  readonly error?: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const { open } = props;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal modal-bottom sm:modal-middle"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        if (props.busy === true) event.preventDefault();
      }}
      onClose={() => {
        if (!props.open) return;
        // The browser lets a second Escape through without user activation in between, even when the first was refused.
        if (props.busy === true) ref.current?.showModal();
        else props.onCancel();
      }}
    >
      <div className="modal-box max-w-lg">
        <h2 id={titleId} className="text-lg font-semibold">
          {props.title}
        </h2>
        <div id={bodyId} className="mt-3 flex flex-col gap-2">
          {props.children}
        </div>
        <ActionError message={props.error} className="mt-3" />
        <div className="modal-action">
          <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} onClick={props.onCancel} disabled={props.busy}>
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${props.tone === "error" ? "btn-error" : "btn-primary"}`}
            onClick={props.onConfirm}
            disabled={props.busy}
            aria-busy={props.busy}
          >
            {props.busy === true && <span className="loading loading-spinner loading-sm" />}
            {props.confirmLabel}
          </button>
        </div>
      </div>
      {/* A click outside the box closes the dialog; the keyboard has Escape and Cancel, so this is no tab stop. */}
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={props.busy} tabIndex={-1} aria-hidden="true">
          Close
        </button>
      </form>
    </dialog>
  );
}
