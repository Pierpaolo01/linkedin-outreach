import { useEffect, useRef, useState } from "react";
import { resumeSafetyStop, toApiError } from "../api";
import type { SafetyStop, Session } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { asSentence, formatWhen } from "../format";
import { ActionError, FailureWords, focusInView, ON_RED_BUTTON } from "../formParts";
import { failure, type Failure } from "../words";
import { IconStop } from "../icons";
import { sessionView, STOP_REASON } from "./sessionView";
import type { Recheck } from "./useRecheck";

/*
 * Below 640px the icon sits beside the heading, centred on its first line, and the button takes the full width under
 * the words; from 640px icon, words and button are one row.
 */
const BAR = "grid grid-cols-[auto_minmax(0,1fr)] gap-3 bg-error px-4 py-4 text-error-content sm:flex sm:items-center lg:px-10";
const ON_RED = `${ON_RED_BUTTON} btn-sm shrink-0 max-sm:col-span-2 sm:ml-auto`;

/** The banner's icon: on a phone one line high at the top, so it centres on the heading's first line. */
function BannerIcon() {
  return (
    <span className="flex h-lh items-center sm:h-auto">
      <IconStop className="size-7 shrink-0" />
    </span>
  );
}

/** The red banner of an active safety stop: what LinkedIn showed, what to do, and Resume (after a confirm). */
export function SafetyStopBanner({ stop }: { readonly stop: SafetyStop }) {
  const { timeZone, refresh } = useAppData();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | undefined>(undefined);
  const now = new Date();
  const whatToDo = asSentence(stop.whatToDo);

  const resume = () => {
    setBusy(true);
    setError(undefined);
    resumeSafetyStop()
      .then(() => {
        setConfirming(false);
        refresh();
      })
      .catch((failed: unknown) => {
        const apiError = toApiError(failed);
        // Someone already resumed it (another tab): nothing left to do.
        if (apiError.status === 409) {
          setConfirming(false);
          refresh();
        } else setError(failure("The safety stop was not lifted. Nothing runs on LinkedIn yet; press the button again, or Not yet.", apiError));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div role="alert" className={BAR} data-testid="safety-stop">
      <BannerIcon />
      <div className="min-w-0">
        <p className="font-semibold">Safety stop. All LinkedIn activity is stopped.</p>
        <p className="text-error-content/90">
          {STOP_REASON[stop.reason].sentence} {stop.detail !== null && asSentence(stop.detail)}
        </p>
        <p className="text-error-content/90">What to do: {whatToDo}</p>
        <p className="text-sm text-error-content/90">
          Stopped {formatWhen(stop.raisedAt, timeZone, now)}.
          {stop.invitesBlockedUntil !== null && ` Invites stay off until ${formatWhen(stop.invitesBlockedUntil, timeZone, now)}, even after you resume.`}
        </p>
      </div>
      <button
        type="button"
        className={ON_RED}
        onClick={() => {
          setError(undefined);
          setConfirming(true);
        }}
      >
        Resume
      </button>
      <ConfirmDialog
        open={confirming}
        title="Resume LinkedIn activity?"
        confirmLabel="I have done this, resume"
        busyLabel="Resuming…"
        cancelLabel="Not yet"
        busy={busy}
        error={error}
        onConfirm={resume}
        onCancel={() => setConfirming(false)}
      >
        <p>Before you resume: {whatToDo}</p>
        <p className="text-base-content">If LinkedIn still shows the problem, the app stops again by itself the next time it opens a page.</p>
      </ConfirmDialog>
    </div>
  );
}

/** A red banner when the last session check found LinkedIn needing the user, and there is no safety stop yet. */
export function SessionBanner({ session, recheck }: { readonly session: Session; readonly recheck: Recheck }) {
  const view = sessionView(session);
  if (view.problem === undefined) return null;
  return (
    <div role="alert" className={BAR} data-testid="session-problem">
      <BannerIcon />
      <div className="min-w-0">
        <p className="font-semibold">LinkedIn needs you.</p>
        <p className="text-error-content/90">{view.problem}</p>
        {recheck.error?.from === "banner" && <RecheckFailed failure={recheck.error} onRed className="mt-1.5" />}
      </div>
      <button type="button" className={ON_RED} disabled={recheck.checking} aria-busy={recheck.checking} onClick={() => recheck.run("banner")}>
        {recheck.checking && <span className="loading loading-spinner loading-sm" />}
        Re-check
      </button>
    </div>
  );
}

/** A quiet warning when the app does not answer. */
export function UnreachableBanner({ message }: { readonly message: string }) {
  return (
    <div role="status" className="bg-warning px-4 py-3 text-warning-content lg:px-10">
      {message}
    </div>
  );
}

/**
 * A Re-check that did not finish, said beside the button that was pressed: what failed and what to do, then what the
 * app said, apart (`FailureWords`, the one failure pattern; in its `ActionError` box off the red surfaces). It takes
 * the focus when it appears, since the button was off while the check ran.
 */
export function RecheckFailed({ failure: failed, onRed, className }: { readonly failure: Failure; readonly onRed: boolean; readonly className?: string }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (onRed && line.current !== null) focusInView(line.current);
  }, [failed, onRed]);
  if (!onRed) return <ActionError message={failed} takeFocus className={className ?? ""} testId="recheck-error" />;
  return (
    <div ref={line} role="alert" tabIndex={-1} className={`text-sm ${className ?? ""}`} data-testid="recheck-error">
      <FailureWords message={failed} onRed />
    </div>
  );
}
