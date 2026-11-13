import { useAppData } from "../appData";
import { formatClock, formatDays, workingNow } from "../format";
import { ON_RED_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON, StatusDot, statusLabel } from "../formParts";
import { IconX } from "../icons";
import { Link } from "../router";
import { currentNavTarget } from "./currentNav";
import { sessionView, STOP_REASON } from "./sessionView";
import type { Recheck } from "./useRecheck";

export const SIDEBAR_ID = "sidebar";

/**
 * The left column on a wide screen, the menu on a phone: session, the eight destinations, the working window. As a menu
 * (below 1024px) it has its own Close button, so a touch screen reader can close it from inside.
 */
export function Sidebar(props: { readonly path: string; readonly recheck: Recheck; readonly onNavigate: () => void; readonly onClose: () => void }) {
  const { path, recheck, onNavigate } = props;
  const { home } = useAppData();
  const campaigns = home?.campaigns ?? [];
  const stopped = home?.safetyStop != null;
  // Exactly one item is current on every page; the wizard, new or a draft's, is within Campaigns.
  const current = currentNavTarget(path, campaigns.map((c) => c.id));
  return (
    <aside id={SIDEBAR_ID} className="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-200" aria-label="Sidebar">
      {/* Boxes (the session card, the menu's items) start 12px in; text starts 24px in, the menu's own text inset. */}
      <div className="px-3 pt-6 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="px-3 text-lg font-semibold">Outreach</p>
          <button type="button" className={`${QUIET_BUTTON} btn-square -my-2.5 size-11 lg:hidden`} aria-label="Close menu" onClick={props.onClose}>
            <IconX className="size-5" />
          </button>
        </div>
        <SessionCard recheck={recheck} />
      </div>
      <nav aria-label="Main">
        <ul className="menu w-full gap-0.5 px-3 text-nav">
          <NavItem to="/" label="Home" current={current} onNavigate={onNavigate} />
          <NavItem to="/approvals" label="Approval queue" count={home?.needsYou.pendingApproval} current={current} onNavigate={onNavigate} />
          <NavItem to="/review" label="Needs review" count={home?.needsYou.needsReview} current={current} onNavigate={onNavigate} />
          <li className="mt-3">
            <Link
              to="/campaigns"
              className={current === "/campaigns" ? "menu-active" : ""}
              aria-current={current === "/campaigns" ? "page" : undefined}
              onClick={onNavigate}
            >
              Campaigns
            </Link>
            {campaigns.length > 0 && (
              <ul>
                {campaigns.map((c) => {
                  const to = `/campaigns/${c.id}`;
                  return (
                    <li key={c.id}>
                      {/*
                       * A long name takes two lines, then ends in an ellipsis; the full name shows on hover. The dot sits
                       * in a box one line high, so it stays on the name's first line.
                       */}
                      <Link
                        to={to}
                        title={c.name}
                        className={`items-start text-sm ${current === to ? "menu-active" : ""}`}
                        aria-current={current === to ? "page" : undefined}
                        onClick={onNavigate}
                      >
                        <span className="flex h-lh shrink-0 items-center" aria-hidden="true">
                          <StatusDot status={c.status} safetyStop={stopped} />
                        </span>
                        <span className="line-clamp-2 min-w-0 whitespace-normal wrap-break-word" data-testid="sidebar-campaign-name">
                          {c.name}
                        </span>
                        <span className="sr-only">, {statusLabel(c.status, stopped)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
          <li className="mt-3" aria-hidden="true" />
          <NavItem to="/activity" label="Activity log" current={current} onNavigate={onNavigate} />
          <NavItem to="/stats" label="Stats" current={current} onNavigate={onNavigate} />
          <NavItem to="/settings" label="Settings" current={current} onNavigate={onNavigate} />
        </ul>
      </nav>
      <WorkingLine />
    </aside>
  );
}

function NavItem(props: {
  readonly to: string;
  readonly label: string;
  /** The address of the current item (`currentNavTarget`). */
  readonly current: string | undefined;
  readonly count?: number | undefined;
  readonly onNavigate: () => void;
}) {
  const active = props.current === props.to;
  return (
    <li>
      <Link to={props.to} className={active ? "menu-active" : ""} aria-current={active ? "page" : undefined} onClick={props.onNavigate}>
        <span className="grow">{props.label}</span>
        {props.count !== undefined && props.count > 0 && (
          <span className="badge badge-sm nums border-0 bg-accent font-semibold text-accent-content" data-testid={`count-${props.to.slice(1)}`}>
            {props.count}
          </span>
        )}
      </Link>
    </li>
  );
}

function SessionCard({ recheck }: { readonly recheck: Recheck }) {
  const { home, timeZone } = useAppData();
  if (home === undefined) {
    return (
      // As tall as the loaded card (two lines; a 44px Re-check below 1024px), so the menu under it does not move.
      <div className="mt-3 min-h-16 rounded-box bg-base-100 px-3 py-2.5 text-sm max-lg:min-h-21">
        <span role="status" className="loading loading-dots loading-sm" aria-label="Loading" />
      </div>
    );
  }
  const view = sessionView(home.session);
  const stop = home.safetyStop;
  const checked = home.session.lastCheckedAt === null ? "Never checked" : `Last checked ${formatClock(home.session.lastCheckedAt, timeZone)}`;
  return (
    <div className={`mt-3 rounded-box px-3 py-2.5 text-sm ${stop === null ? "bg-base-100" : "bg-error text-error-content"}`}>
      {stop !== null && (
        <p className="mb-1.5 font-semibold">
          Safety stop: {STOP_REASON[stop.reason].short.toLowerCase()}, since {formatClock(stop.raisedAt, timeZone)}
        </p>
      )}
      {/* During a stop the window's sentence takes the card's width, with Re-check under it. */}
      <div className={stop === null ? "flex items-center justify-between gap-2" : "flex flex-col items-start gap-2"}>
        {stop === null ? (
          <p className="flex min-w-0 items-center gap-2 font-medium">
            <span className={`status ${view.light}`} aria-hidden="true" />
            <span data-testid="session-status" className="truncate">
              {view.label}
            </span>
          </p>
        ) : (
          // During a stop the window's state is secondary: one plain line, no light, so nothing on the card reads as all clear.
          <p className="min-w-0 text-error-content/90">
            <span data-testid="session-status">{view.window}</span>. <span data-testid="last-checked">{checked}</span>.
          </p>
        )}
        <button
          type="button"
          className={`${stop === null ? SECONDARY_BUTTON : ON_RED_BUTTON} btn-xs shrink-0`}
          disabled={recheck.checking}
          aria-busy={recheck.checking}
          onClick={recheck.run}
        >
          {recheck.checking && <span className="loading loading-spinner loading-xs" />}
          Re-check
        </button>
      </div>
      {stop === null && (
        <p data-testid="last-checked" className="text-muted">
          {checked}
        </p>
      )}
      {recheck.error !== undefined && (
        <p role="alert" className={`mt-1.5 ${stop === null ? "text-error" : ""}`}>
          {recheck.error}
        </p>
      )}
    </div>
  );
}

function WorkingLine() {
  const { home, settings } = useAppData();
  if (settings === undefined) return null;
  const now = workingNow(settings, new Date());
  const next =
    home?.safetyStop != null
      ? "Nothing runs on LinkedIn until you resume."
      : now.open
        ? `Working now, until ${now.until}.`
        : `Outside the working window. Starts again ${now.next}.`;
  return (
    <p className="mt-auto px-6 pt-6 pb-6 text-sm text-muted">
      Working {formatDays(settings.workingDays)},{" "}
      <span className="whitespace-nowrap">
        {settings.workingHours.start} to {settings.workingHours.end}.
      </span>
      <br />
      {next}
    </p>
  );
}
