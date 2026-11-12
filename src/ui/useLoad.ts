import { useCallback, useEffect, useEffectEvent, useState } from "react";
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

/**
 * Loads data for `key` and loads again whenever `key` changes or `reload()` is called. While a new
 * key loads, the answer is "loading" unless `keepPrevious` is set, in which case the last data
 * stays on screen until the new answer arrives (for screens that refresh in the background).
 */
export function useLoad<T>(load: () => Promise<T>, key: string, { keepPrevious = false } = {}): Loaded<T> & { readonly reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const [stored, setStored] = useState<Stored<T> | undefined>(undefined);
  const run = useEffectEvent(load);

  useEffect(() => {
    let live = true;
    run().then(
      (data) => {
        if (live) setStored({ key, data, error: undefined });
      },
      (error: unknown) => {
        if (live) setStored((previous) => ({ key, data: previous?.key === key ? previous.data : undefined, error: toApiError(error) }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const usable = stored !== undefined && (stored.key === key || keepPrevious) ? stored : undefined;
  if (usable === undefined) return { status: "loading", data: undefined, error: undefined, reload };
  if (usable.error !== undefined) return { status: "error", data: usable.data, error: usable.error, reload };
  if (usable.data === undefined) return { status: "loading", data: undefined, error: undefined, reload };
  return { status: "ok", data: usable.data, error: undefined, reload };
}
