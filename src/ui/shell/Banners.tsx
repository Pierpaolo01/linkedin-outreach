import { useState } from "react";
import { resumeSafetyStop, toApiError } from "../api";
import type { SafetyStop, Session } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { asSentence, formatWhen } from "../format";
import { ON_RED_BUTTON } from "../formParts";
import { IconStop } from "../icons";
import { sessionView, STOP_REASON } from "./sessionView";
import type { Recheck } from "./useRecheck";

const BAR = "flex flex-col gap-3 bg-error px-4 py-4 text-error-content sm:flex-row sm:items-center lg:px-10";
const ON_RED = `${ON_RED_BUTTON} btn-sm shrink-0 sm:ml-auto`;

/** The red banner of an active safety stop: what LinkedIn showed, what to do, and Resume (after a confirm). */
export function SafetyStopBanner({ stop }: { readonly stop: SafetyStop }) {
  const { timeZone, refresh } = useAppData();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
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
      .catch((failure: unknown) => {
        const apiError = toApiError(failure);
        // Someone already resumed it (another tab): nothing left to do.
        if (apiError.status === 409) {
          setConfirming(false);
          refresh();
        } else setError(apiError.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div role="alert" className={BAR} data-testid="safety-stop">
      <IconStop className="hidden size-7 shrink-0 sm:block" />
      <div className="min-w-0">
        <p className="font-semibold">Safety stop. All LinkedIn activity is stopped.</p>
        <p className="text-error-content/90">
          {STOP_REASON[stop.reason].sentence} {stop.detail !== null && asSentence(stop.detail)}
        </p>
        <p className="text-error-content/90">What to do: {whatToDo}</p>
        <p className="text-sm text-error-content/80">
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
        cancelLabel="Not yet"
        busy={busy}
        error={error}
        onConfirm={resume}
        onCancel={() => setConfirming(false)}
      >
        <p>Before you resume: {whatToDo}</p>
        <p className="text-base-content/75">If LinkedIn still shows the problem, the app stops again by itself the next time it opens a page.</p>
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
      <IconStop className="hidden size-7 shrink-0 sm:block" />
      <div className="min-w-0">
        <p className="font-semibold">LinkedIn needs you.</p>
        <p className="text-error-content/90">{view.problem}</p>
      </div>
      <button type="button" className={ON_RED} disabled={recheck.checking} onClick={recheck.run}>
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
