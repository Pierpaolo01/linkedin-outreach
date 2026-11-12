import { useAppData } from "../appData";
import { formatClock, formatWorkingHours, workingNow } from "../format";
import { ON_RED_BUTTON, SECONDARY_BUTTON, StatusDot } from "../formParts";
import { Link } from "../router";
import { sessionView, STOP_REASON } from "./sessionView";
import type { Recheck } from "./useRecheck";

/** The left column on a wide screen, the menu on a phone: session, the eight destinations, working hours. */
export function Sidebar({ path, recheck, onNavigate }: { readonly path: string; readonly recheck: Recheck; readonly onNavigate: () => void }) {
  const { home } = useAppData();
  const campaigns = home?.campaigns ?? [];
  const stopped = home?.safetyStop != null;
  return (
    <aside className="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-200" aria-label="Sidebar">
      <div className="px-5 pt-6 pb-4">
        <p className="text-lg font-semibold">Outreach</p>
        <SessionCard recheck={recheck} />
      </div>
      <nav aria-label="Main">
        <ul className="menu w-full gap-0.5 px-3 text-nav">
          <NavItem to="/" label="Home" path={path} onNavigate={onNavigate} />
          <NavItem to="/approvals" label="Approval queue" count={home?.needsYou.pendingApproval} path={path} onNavigate={onNavigate} />
          <NavItem to="/review" label="Needs review" count={home?.needsYou.needsReview} path={path} onNavigate={onNavigate} />
          <li className="mt-3">
            <Link
              to="/campaigns"
              className={path === "/campaigns" || path === "/campaigns/new" ? "menu-active" : ""}
              aria-current={path === "/campaigns" ? "page" : undefined}
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
                      <Link to={to} className={`text-sm ${path === to ? "menu-active" : ""}`} aria-current={path === to ? "page" : undefined} onClick={onNavigate}>
                        <StatusDot status={c.status} safetyStop={stopped} />
                        <span className="truncate">{c.name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
          <li className="mt-3" aria-hidden="true" />
          <NavItem to="/activity" label="Activity log" path={path} onNavigate={onNavigate} />
          <NavItem to="/stats" label="Stats" path={path} onNavigate={onNavigate} />
          <NavItem to="/settings" label="Settings" path={path} onNavigate={onNavigate} />
        </ul>
      </nav>
      <WorkingLine />
    </aside>
  );
}

function NavItem(props: { readonly to: string; readonly label: string; readonly path: string; readonly count?: number | undefined; readonly onNavigate: () => void }) {
  const active = props.path === props.to;
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
      <div className="mt-3 rounded-box bg-base-100 px-3 py-2.5 text-sm">
        <span className="loading loading-dots loading-sm" aria-label="Loading" />
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
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 font-medium">
          <span className={`status ${stop === null ? view.light : "status-neutral bg-error-content"}`} aria-hidden="true" />
          <span data-testid="session-status" className="truncate">
            {view.label}
          </span>
        </p>
        <button
          type="button"
          className={`${stop === null ? SECONDARY_BUTTON : ON_RED_BUTTON} btn-xs shrink-0`}
          disabled={recheck.checking}
          onClick={recheck.run}
        >
          {recheck.checking && <span className="loading loading-spinner loading-xs" />}
          Re-check
        </button>
      </div>
      <p data-testid="last-checked" className={stop === null ? "text-base-content/65" : "text-error-content/85"}>
        {checked}
      </p>
      {recheck.error !== undefined && (
        <p role="status" className={`mt-1.5 ${stop === null ? "text-error" : ""}`}>
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
        : `Outside working hours. Starts again ${now.next}.`;
  return (
    <p className="mt-auto px-6 pt-6 pb-6 text-sm text-base-content/65">
      {formatWorkingHours(settings)}.
      <br />
      {next}
    </p>
  );
}
