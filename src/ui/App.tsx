import { useEffect, useState } from "react";
import { AppDataProvider, useAppData } from "./appData";
import { IconMenu } from "./icons";
import { ComingSoon } from "./pages/ComingSoon";
import { matchPath, usePath } from "./router";
import { ROUTES } from "./routes";
import { SafetyStopBanner, SessionBanner, UnreachableBanner } from "./shell/Banners";
import { Sidebar } from "./shell/Sidebar";
import { sessionView } from "./shell/sessionView";
import { useRecheck } from "./shell/useRecheck";

const DRAWER_ID = "main-menu";

export function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}

function findRoute(path: string) {
  for (const route of ROUTES) {
    const params = matchPath(route.path, path);
    if (params !== null) return { route, params };
  }
  return null;
}

/** The sidebar desk: a fixed sidebar on a wide screen, a menu on a phone; banners above the page. */
function Shell() {
  const path = usePath();
  const { home, homeError } = useAppData();
  const recheck = useRecheck();
  // The menu is open for the page it was opened on; following a link closes it.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === path;
  const found = findRoute(path);

  useEffect(() => {
    document.title = `${found?.route.title ?? "Not found"} | LinkedIn outreach`;
  }, [found?.route.title]);

  const session = home === undefined ? undefined : sessionView(home.session);

  return (
    <div className="drawer min-h-screen bg-base-100 lg:drawer-open">
      <input
        id={DRAWER_ID}
        type="checkbox"
        className="drawer-toggle"
        checked={menuOpen}
        onChange={(event) => setMenuOpenAt(event.target.checked ? path : null)}
        aria-label="Menu"
      />
      <div className="drawer-content flex min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-base-300 px-2 py-2 lg:hidden">
          <label htmlFor={DRAWER_ID} className="btn btn-ghost btn-square size-11" aria-label="Open menu">
            <IconMenu />
          </label>
          <span className="font-semibold">Outreach</span>
          {session !== undefined && (
            <span className="ml-auto flex items-center gap-2 pr-2 text-sm">
              <span className={`status ${home?.safetyStop == null ? session.light : "status-error"}`} aria-hidden="true" />
              {home?.safetyStop == null ? session.label : "Safety stop"}
            </span>
          )}
        </header>

        {homeError !== undefined && <UnreachableBanner message={homeError.message} />}
        {home?.safetyStop != null ? (
          <SafetyStopBanner stop={home.safetyStop} />
        ) : (
          home !== undefined && <SessionBanner session={home.session} recheck={recheck} />
        )}

        <main className="w-full max-w-page px-4 py-6 lg:px-10 lg:py-8">
          {found === null ? <ComingSoon title="Page not found" lead="There is no page at this address." about="Use the menu to find your way." /> : found.route.render(found.params)}
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor={DRAWER_ID} aria-label="Close menu" className="drawer-overlay" />
        <Sidebar path={path} recheck={recheck} onNavigate={() => setMenuOpenAt(null)} />
      </div>
    </div>
  );
}
