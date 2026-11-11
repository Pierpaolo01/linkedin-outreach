import { useCallback, useEffect, useState } from "react";
import { checkSession, getSession, type Session } from "./api";

const POLL_MS = 5_000;

type Status = Session["status"];

interface StatusView {
  readonly label: string;
  /** daisyUI status colour for the light. */
  readonly light: "status-success" | "status-warning" | "status-error" | "status-neutral";
  readonly line: string;
  /** A safety stop: shown as a red banner. */
  readonly stop?: string;
}

const STOPPED = "All LinkedIn activity is stopped.";

const VIEWS: Readonly<Record<Status, StatusView>> = {
  ok: { label: "Connected", light: "status-success", line: "The dedicated window is logged in to LinkedIn." },
  logged_out: {
    label: "Logged out",
    light: "status-warning",
    line: "Log in to LinkedIn in the dedicated window, then press Re-check.",
  },
  checkpoint: {
    label: "Checkpoint",
    light: "status-error",
    line: "LinkedIn is asking for a security check.",
    stop: "LinkedIn is asking for a security check in the dedicated window. Complete it there yourself, then press Re-check.",
  },
  restricted: {
    label: "Restricted",
    light: "status-error",
    line: "LinkedIn shows a restriction or warning on the account.",
    stop: "LinkedIn shows a restriction or warning on the account. Read it in the dedicated window and do not try to get past it. Press Re-check once LinkedIn has lifted it.",
  },
  search_capped: {
    label: "Search limit reached",
    light: "status-warning",
    line: "LinkedIn's monthly search limit is reached. Search waits until next month; everything else continues.",
  },
  unknown: { label: "Not checked yet", light: "status-neutral", line: "Not checked yet." },
};

function viewFor(session: Session): StatusView {
  if (session.status === "unknown" && session.lastCheckedAt !== null) {
    return {
      label: "Unknown",
      light: "status-neutral",
      line: "The last check could not tell. Make sure the dedicated window shows LinkedIn, then press Re-check.",
    };
  }
  return VIEWS[session.status];
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function Home() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [unreachable, setUnreachable] = useState<string | undefined>(undefined);
  const [rechecking, setRechecking] = useState(false);
  const [checkError, setCheckError] = useState<string | undefined>(undefined);

  const refresh = useCallback(
    () =>
      getSession().then(
        (next) => {
          setSession(next);
          setUnreachable(undefined);
        },
        (error: unknown) => setUnreachable(error instanceof Error ? error.message : String(error)),
      ),
    [],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const recheck = async () => {
    setRechecking(true);
    setCheckError(undefined);
    try {
      const result = await checkSession();
      if (result.kind === "busy") {
        await refresh();
      } else {
        setSession(result.session);
        if (result.kind === "failed") setCheckError(result.error);
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setRechecking(false);
    }
  };

  const checking = rechecking || session?.checking === true;
  const view = session === undefined ? undefined : viewFor(session);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="home-title">
      <h1 id="home-title" className="text-2xl font-semibold">
        Home
      </h1>

      {unreachable !== undefined && (
        <div role="status" className="alert alert-warning alert-soft">
          Cannot reach the app: {unreachable}. Is it still running?
        </div>
      )}

      {view?.stop !== undefined && (
        <div role="alert" className="alert alert-error">
          <div>
            <p className="font-semibold">Safety stop: {STOPPED}</p>
            <p>{view.stop}</p>
          </div>
        </div>
      )}

      <div className="card card-border bg-base-100">
        <div className="card-body gap-3">
          <h2 className="card-title text-base">LinkedIn session</h2>
          {session === undefined || view === undefined ? (
            <span className="loading loading-dots loading-sm" aria-label="Loading" />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className={`status status-lg ${view.light}`} />
                <span data-testid="session-status" className="text-lg font-medium">
                  {view.label}
                </span>
              </div>
              <p>{view.line}</p>
              <p data-testid="last-checked" className="text-sm text-base-content/70">
                {session.lastCheckedAt === null
                  ? "Never checked."
                  : `Last checked ${timeFormat.format(new Date(session.lastCheckedAt))}.`}
              </p>
              {session.lastError !== null && session.status !== "ok" && (
                <p className="text-sm text-base-content/70">Details: {session.lastError}</p>
              )}
              {checkError !== undefined && (
                <p role="status" className="text-sm text-error">
                  The check did not finish: {checkError}
                </p>
              )}
            </>
          )}
          <div className="card-actions justify-end">
            <button type="button" className="btn btn-primary" disabled={checking} onClick={() => void recheck()}>
              {checking && <span className="loading loading-spinner loading-sm" />}
              Re-check
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
