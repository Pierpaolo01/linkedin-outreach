import { useState } from "react";
import { checkSession, toApiError } from "../api";
import { useAppData } from "../appData";
import { failure, type Failure } from "../words";

/** Where Re-check was pressed, so its failure is said beside that button and not elsewhere. */
export type RecheckFrom = "sidebar" | "banner" | "settings";

export interface Recheck {
  /** A check is running (this one, or the app's own startup check). */
  readonly checking: boolean;
  /** Why the last check did not finish, said beside the Re-check that was pressed (`from`). */
  readonly error: (Failure & { readonly from: RecheckFrom }) | undefined;
  readonly run: (from: RecheckFrom) => void;
}

const NOT_FINISHED = "The check did not finish. Nothing changed; press Re-check again.";

/** Re-check of the LinkedIn session: asks the app to look now, then reloads Home. */
export function useRecheck(): Recheck {
  const { home, refresh } = useAppData();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Recheck["error"]>(undefined);

  const run = (from: RecheckFrom) => {
    setRunning(true);
    setError(undefined);
    checkSession()
      .then((result) => {
        if (result.kind === "failed") setError({ ...failure(NOT_FINISHED, result.error), from });
      })
      .catch((failed: unknown) => setError({ ...failure(NOT_FINISHED, toApiError(failed)), from }))
      .finally(() => {
        setRunning(false);
        refresh();
      });
  };

  return { checking: running || home?.session.checking === true, error, run };
}
