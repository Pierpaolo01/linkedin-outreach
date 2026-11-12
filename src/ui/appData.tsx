import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import { getHome, getSettings, type ApiError } from "./api";
import type { Home, Settings } from "./apiSchemas";
import { useLoad } from "./useLoad";

/** How often the shell asks the app for Home (session, safety stop, counts). */
const POLL_MS = 5_000;
const FALLBACK_TIME_ZONE = "Europe/Rome";

export interface AppData {
  /** The latest Home answer, kept on screen while the next one loads. */
  readonly home: Home | undefined;
  /** Set while the app cannot be reached or answered with an error. */
  readonly homeError: ApiError | undefined;
  readonly settings: Settings | undefined;
  /** The app's time zone; every time on screen is shown in it. */
  readonly timeZone: string;
  /** Ask for Home again now (after a decision, so the counts and banners update at once). */
  readonly refresh: () => void;
  /** Ask for Settings again (the Settings page calls it after a save). */
  readonly refreshSettings: () => void;
}

const AppDataContext = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { readonly children: ReactNode }) {
  const home = useLoad(getHome, "home", { keepPrevious: true });
  const settings = useLoad(getSettings, "settings", { keepPrevious: true });
  const { reload } = home;

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const value = useMemo<AppData>(
    () => ({
      home: home.data,
      homeError: home.error,
      settings: settings.data,
      timeZone: settings.data?.timeZone ?? FALLBACK_TIME_ZONE,
      refresh: reload,
      refreshSettings: settings.reload,
    }),
    [home.data, home.error, settings.data, reload, settings.reload],
  );
  return <AppDataContext value={value}>{children}</AppDataContext>;
}

export function useAppData(): AppData {
  const value = use(AppDataContext);
  if (value === null) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
