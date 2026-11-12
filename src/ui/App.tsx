import { useEffect, useRef, useState, type MouseEvent } from "react";
import { AppDataProvider, useAppData } from "./appData";
import { tabTitle } from "./format";
import { Announce } from "./formParts";
import { IconMenu } from "./icons";
import { ComingSoon } from "./pages/ComingSoon";
import { PAGE_TITLE_ID } from "./pages/PageHeader";
import { matchPath, usePath } from "./router";
import { ROUTES } from "./routes";
import { SafetyStopBanner, SessionBanner, UnreachableBanner } from "./shell/Banners";
import { Sidebar, SIDEBAR_ID } from "./shell/Sidebar";
import { sessionView } from "./shell/sessionView";
import { useRecheck } from "./shell/useRecheck";

const DRAWER_ID = "main-menu";
const MAIN_ID = "page";
/** The two addresses of the wizard: a new campaign's address becomes its draft's while the user types. */
const WIZARD = new Set(["/campaigns/new", "/campaigns/:id/edit"]);

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

/** Focus `element` once it can take it: the drawer becomes visible a moment after it is opened. */
function focusWhenShown(element: HTMLElement | null | undefined, tries = 20) {
  if (element == null) return;
  element.focus();
  if (document.activeElement !== element && tries > 0) requestAnimationFrame(() => focusWhenShown(element, tries - 1));
}

const firstMenuLink = () => document.querySelector<HTMLElement>(`#${SIDEBAR_ID} nav a`);

/** The sidebar desk: a fixed sidebar on a wide screen, a menu on a phone; banners above the page. */
function Shell() {
  const path = usePath();
  const { home, homeError } = useAppData();
  const recheck = useRecheck();
  // The menu is open for the page it was opened on; following a link closes it.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === path;
  const found = findRoute(path);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = tabTitle(found?.route.title ?? "Not found");
  }, [found?.route.title]);

  // While the menu is open on a phone it is a modal: the page behind is inert (see the markup), focus starts on
  // its first link, and Escape closes it. Closed without leaving the page, focus goes back to the menu button.
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    if (menuOpen) {
      openedOn.current = path;
      focusWhenShown(firstMenuLink());
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setMenuOpenAt(null);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
    if (openedOn.current === null) return;
    if (openedOn.current === path) menuButton.current?.focus();
    openedOn.current = null;
    return;
  }, [menuOpen, path]);

  // From 1024px the menu is the docked sidebar: an open phone menu must not leave the page inert there.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 64rem)");
    const onChange = () => {
      if (wide.matches) setMenuOpenAt(null);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // A new page takes focus at its title, so the keyboard and a screen reader start there and not on the link left behind,
  // unless the page has already put the focus on something of its own (the wizard's Name field).
  const shownPage = useRef<string | null>(null);
  const pageKey = found === null ? "none" : WIZARD.has(found.route.path) ? "wizard" : path;
  useEffect(() => {
    const before = shownPage.current;
    shownPage.current = pageKey;
    if (before === null || before === pageKey) return;
    const page = document.getElementById(MAIN_ID);
    const active = document.activeElement;
    if (page !== null && active !== null && active !== page && page.contains(active)) return;
    document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true });
  }, [pageKey]);

  const session = home === undefined ? undefined : sessionView(home.session);

  return (
    <div className="drawer min-h-screen bg-base-100 lg:drawer-open">
      {/* The drawer's state for daisyUI's styles only; the menu button below is the control. */}
      <input id={DRAWER_ID} type="checkbox" className="drawer-toggle" checked={menuOpen} onChange={(event) => setMenuOpenAt(event.target.checked ? path : null)} tabIndex={-1} aria-hidden="true" />
      <div className="drawer-content flex min-w-0 flex-col" inert={menuOpen}>
        <SkipLink to={MAIN_ID}>Skip to content</SkipLink>
        <SkipLink to={SIDEBAR_ID} className="max-lg:hidden">
          Skip to menu
        </SkipLink>
        <header className="flex items-center gap-2 border-b border-base-300 px-2 py-2 lg:hidden">
          <button
            ref={menuButton}
            type="button"
            className="btn btn-ghost btn-square size-11"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls={SIDEBAR_ID}
            onClick={() => setMenuOpenAt(path)}
          >
            <IconMenu />
          </button>
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

        <main id={MAIN_ID} tabIndex={-1} className="w-full max-w-page px-4 py-6 lg:px-10 lg:py-8">
          {found === null ? <ComingSoon title="Page not found" lead="There is no page at this address." about="Use the menu to find your way." /> : found.route.render(found.params)}
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor={DRAWER_ID} aria-label="Close menu" className="drawer-overlay" />
        <Sidebar path={path} recheck={recheck} onNavigate={() => setMenuOpenAt(null)} onClose={() => setMenuOpenAt(null)} />
      </div>
      <SessionNews label={session?.label} />
    </div>
  );
}

/** A link that is out of sight until the keyboard reaches it, and moves focus to `to` (the page or the menu). */
function SkipLink({ to, className, children }: { readonly to: string; readonly className?: string; readonly children: string }) {
  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById(to);
    (to === SIDEBAR_ID ? firstMenuLink() : target)?.focus();
  };
  return (
    <a
      href={`#${to}`}
      onClick={skip}
      className={`skip-link rounded-field border border-base-300 bg-base-100 px-3 py-2 font-medium ${className ?? ""}`}
    >
      {children}
    </a>
  );
}

/** Says when the dedicated window's state changes (after Re-check, or by itself), to a screen reader. Not on the first load. */
function SessionNews({ label }: { readonly label: string | undefined }) {
  const [said, setSaid] = useState<string | undefined>(undefined);
  const [last, setLast] = useState(label);
  if (label !== last) {
    setLast(label);
    if (last !== undefined && label !== undefined) setSaid(`Dedicated window: ${label}.`);
  }
  return <Announce message={said} />;
}
