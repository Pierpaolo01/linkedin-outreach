import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { toApiError, type ApiError } from "./api";

export type Loaded<T> =
  | { readonly status: "loading"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "ok"; readonly data: T; readonly error: undefined }
  | { readonly status: "error"; readonly data: T | undefined; readonly error: ApiError };

interface Stored<T> {
  readonly key: string;
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
}

/** How often a screen that follows the engine loads again in the background. */
export const FOLLOW_ENGINE_MS = 10_000;

/** The first wait before a failed first load is tried again; each further wait is twice as long. */
const RETRY_FIRST_MS = 1_000;

/**
 * Loads data for `key` and loads again whenever `key` changes or `reload()` is called. While a new
 * key loads, the answer is "loading" unless `keepPrevious` is set, in which case the last data
 * stays on screen until the new answer arrives (for screens that refresh in the background).
 * With `retries`, a first load that fails (no data yet for this key) is tried again by itself that
 * many times, after 1 s, 2 s, 4 s…; the error is the answer meanwhile. `reload()` starts the count again.
 * With `refreshEveryMs`, it also loads again on that interval while the tab is visible.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  key: string,
  { keepPrevious = false, retries = 0, refreshEveryMs = 0 } = {},
): Loaded<T> & { readonly reload: () => void } {
  const [nonce, setNonce] = useState(0);

  // Screens that show what the engine is doing (funnels, stages, activity) load again by themselves
  // while the tab is in view, so they do not go stale between the user's own clicks.
  useEffect(() => {
    if (refreshEveryMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    }, refreshEveryMs);
    return () => clearInterval(timer);
  }, [refreshEveryMs]);
  const [stored, setStored] = useState<Stored<T> | undefined>(undefined);
  const run = useEffectEvent(load);
  /** The key that has data, and how many automatic tries the current key has had. */
  const tries = useRef<{ readonly key: string; readonly count: number; readonly loaded: boolean }>({ key, count: 0, loaded: false });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (tries.current.key !== key) tries.current = { key, count: 0, loaded: false };
    run().then(
      (data) => {
        if (!live) return;
        tries.current = { key, count: 0, loaded: true };
        setStored({ key, data, error: undefined });
      },
      (error: unknown) => {
        if (!live) return;
        setStored((previous) => ({ key, data: previous?.key === key ? previous.data : undefined, error: toApiError(error) }));
        const { count, loaded } = tries.current;
        if (loaded || count >= retries) return;
        tries.current = { key, count: count + 1, loaded };
        timer = setTimeout(() => setNonce((n) => n + 1), RETRY_FIRST_MS * 2 ** count);
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, nonce, retries]);

  const reload = useCallback(() => {
    tries.current = { ...tries.current, count: 0 };
    setNonce((n) => n + 1);
  }, []);

  const usable = stored !== undefined && (stored.key === key || keepPrevious) ? stored : undefined;
  if (usable === undefined) return { status: "loading", data: undefined, error: undefined, reload };
  if (usable.error !== undefined) return { status: "error", data: usable.data, error: usable.error, reload };
  if (usable.data === undefined) return { status: "loading", data: undefined, error: undefined, reload };
  return { status: "ok", data: usable.data, error: undefined, reload };
}
