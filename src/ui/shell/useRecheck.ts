import { useState } from "react";
import { checkSession, toApiError } from "../api";
import { useAppData } from "../appData";

export interface Recheck {
  /** A check is running (this one, or the app's own startup check). */
  readonly checking: boolean;
  readonly error: string | undefined;
  readonly run: () => void;
}

/** Re-check of the LinkedIn session: asks the app to look now, then reloads Home. */
export function useRecheck(): Recheck {
  const { home, refresh } = useAppData();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = () => {
    setRunning(true);
    setError(undefined);
    checkSession()
      .then((result) => {
        if (result.kind === "failed") setError(`The check did not finish: ${result.error}`);
      })
      .catch((failure: unknown) => setError(`The check did not finish: ${toApiError(failure).message}`))
      .finally(() => {
        setRunning(false);
        refresh();
      });
  };

  return { checking: running || home?.session.checking === true, error, run };
}
