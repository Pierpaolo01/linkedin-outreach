// PROTOTYPE layout A, "Sidebar desk": a fixed left sidebar holding all eight screens,
// a two-column Home, and a dense table-first approval queue.
import { useState } from "react";
import {
  ACTIVITY,
  CAMPAIGNS,
  NEEDS_REVIEW,
  PROSPECTS,
  SCREENS,
  SESSION,
  STATUS_LABEL,
  TODAY,
  USAGE,
  WORKING,
  scoreTone,
  type CampaignStatus,
  type ScreenKey,
} from "./data";
import { IconCheck, IconMenu, IconStop, IconX, NotBuilt, useQueue, type VariantProps } from "./shared";

const STATUS_DOT: Readonly<Record<CampaignStatus, string>> = {
  running: "status-success",
  finding: "status-info",
  paused: "status-neutral",
};

const SCORE_CHIP = {
  high: "bg-[#d5e8dc] text-primary",
  mid: "bg-[#f6e3bb] text-[#5c3f07]",
  low: "bg-base-200 text-base-content/55",
} as const;

export function LayoutA({ screen, go, stop }: VariantProps) {
  const [open, setOpen] = useState(false);
  const navigate = (s: ScreenKey) => {
    setOpen(false);
    go(s);
  };
  const session = stop ? SESSION.stop : SESSION.ok;
  const waiting = PROSPECTS.length;

  return (
    <div className="drawer min-h-screen bg-base-100 lg:drawer-open">
      <input id="a-drawer" type="checkbox" className="drawer-toggle" checked={open} onChange={(e) => setOpen(e.target.checked)} />
      <div className="drawer-content flex min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-base-300 px-2 py-2 lg:hidden">
          <label htmlFor="a-drawer" className="btn btn-ghost btn-square" aria-label="Open menu">
            <IconMenu />
          </label>
          <span className="font-semibold">Outreach</span>
          <span className="ml-auto flex items-center gap-2 pr-2 text-sm">
            <span className={`status ${stop ? "status-error" : "status-success"}`} aria-hidden="true" />
            {session.label}
          </span>
        </header>

        {stop && (
          <div role="alert" className="flex flex-col gap-3 bg-error px-4 py-4 text-error-content sm:flex-row sm:items-center lg:px-10">
            <IconStop className="hidden size-7 shrink-0 sm:block" />
            <div className="min-w-0">
              <p className="font-semibold">Safety stop. All LinkedIn activity is stopped.</p>
              <p className="text-error-content/90">{SESSION.stop.banner}</p>
            </div>
            <button type="button" className="btn btn-sm shrink-0 border-error-content/40 bg-error-content text-error sm:ml-auto">
              Re-check
            </button>
          </div>
        )}

        <main className="w-full max-w-[1180px] px-4 py-6 lg:px-10 lg:py-8">
          {screen === "home" ? (
            <Home go={navigate} stop={stop} />
          ) : screen === "approvals" ? (
            <Approvals />
          ) : (
            <NotBuilt title={SCREENS.find((s) => s.key === screen)?.label ?? "Screen"} />
          )}
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="a-drawer" aria-label="Close menu" className="drawer-overlay" />
        <aside className="flex min-h-full w-64 flex-col border-r border-base-300 bg-base-200">
          <div className="px-5 pt-6 pb-4">
            <p className="text-lg font-semibold">Outreach</p>
            <div className={`mt-3 rounded-box px-3 py-2.5 text-sm ${stop ? "bg-error text-error-content" : "bg-base-100"}`}>
              <p className="flex items-center gap-2 font-medium">
                <span className={`status ${stop ? "status-neutral bg-error-content" : "status-success"}`} aria-hidden="true" />
                {session.label}
              </p>
              <p className={stop ? "text-error-content/85" : "text-base-content/65"}>{session.checked}</p>
            </div>
          </div>
          <ul className="menu w-full gap-0.5 px-3 text-[0.95rem]">
            <NavItem label="Home" active={screen === "home"} onClick={() => navigate("home")} />
            <NavItem label="Approval queue" count={waiting} tone="accent" active={screen === "approvals"} onClick={() => navigate("approvals")} />
            <NavItem label="Needs review" count={NEEDS_REVIEW.length} tone="accent" active={screen === "review"} onClick={() => navigate("review")} />
            <li className="mt-3">
              <button type="button" className={screen === "campaigns" ? "menu-active" : ""} onClick={() => navigate("campaigns")}>
                Campaigns
              </button>
              <ul>
                {CAMPAIGNS.map((c, i) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`text-sm ${screen === "campaign" && i === 0 ? "menu-active" : ""}`}
                      onClick={() => navigate("campaign")}
                    >
                      <span className={`status ${STATUS_DOT[c.status]}`} aria-hidden="true" />
                      <span className="truncate">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
            <li className="mt-3" />
            <NavItem label="Activity log" active={screen === "activity"} onClick={() => navigate("activity")} />
            <NavItem label="Stats" active={screen === "stats"} onClick={() => navigate("stats")} />
            <NavItem label="Settings" active={screen === "settings"} onClick={() => navigate("settings")} />
          </ul>
          <p className="mt-auto px-6 pt-6 pb-6 text-sm text-base-content/65">
            {WORKING}.
            <br />
            {stop ? "Nothing runs until you clear the stop." : "Next action in about 2 minutes."}
          </p>
        </aside>
      </div>
    </div>
  );
}

function NavItem(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly count?: number;
  readonly tone?: "accent";
}) {
  return (
    <li>
      <button type="button" className={props.active ? "menu-active" : ""} onClick={props.onClick}>
        <span className="grow text-left">{props.label}</span>
        {props.count !== undefined && props.count > 0 && (
          <span className="badge badge-sm nums border-0 bg-accent font-semibold text-accent-content">{props.count}</span>
        )}
      </button>
    </li>
  );
}

function Home({ go, stop }: { readonly go: (s: ScreenKey) => void; readonly stop: boolean }) {
  const hotel = PROSPECTS.filter((p) => p.campaign === "Hotel owners, Rome").length;
  const trades = PROSPECTS.length - hotel;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-[1.75rem] leading-tight font-semibold">Home</h1>
        <p className="text-base-content/65">{TODAY}</p>
      </div>

      <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <section aria-labelledby="a-needs">
            <h2 id="a-needs" className="mb-3 text-lg font-semibold">
              Needs you
            </h2>
            <div className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
              <NeedRow
                count={PROSPECTS.length}
                title="prospects waiting for approval"
                detail={`${hotel} in Hotel owners, Rome and ${trades} in Local trades, Milan`}
                action="Open queue"
                primary
                onClick={() => go("approvals")}
              />
              <NeedRow
                count={NEEDS_REVIEW.length}
                title="people held for review"
                detail={NEEDS_REVIEW.map((r) => r.name).join(" and ")}
                action="Open"
                onClick={() => go("review")}
              />
            </div>
          </section>

          <section aria-labelledby="a-campaigns">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 id="a-campaigns" className="text-lg font-semibold">
                Campaigns
              </h2>
              <button type="button" className="link text-sm link-hover" onClick={() => go("campaigns")}>
                All campaigns
              </button>
            </div>
            <div className="overflow-x-auto rounded-box border border-base-300">
              <table className="table table-sm text-sm">
                <thead>
                  <tr className="text-base-content/65">
                    <th className="font-medium">Campaign</th>
                    <th className="hidden text-right font-medium md:table-cell">Found</th>
                    <th className="hidden text-right font-medium md:table-cell">Approved</th>
                    <th className="hidden text-right font-medium md:table-cell">Invited</th>
                    <th className="hidden text-right font-medium md:table-cell">Accepted</th>
                    <th className="hidden text-right font-medium md:table-cell">Messaged</th>
                    <th className="hidden text-right font-medium md:table-cell">Replied</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="nums">
                  {CAMPAIGNS.map((c) => (
                    <tr key={c.id}>
                      <td className="py-3 md:min-w-[10.5rem]">
                        <button type="button" className="text-left text-[0.95rem] font-semibold hover:underline" onClick={() => go("campaign")}>
                          {c.name}
                        </button>
                        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-base-content/65">
                          <span className={`status ${stop && c.status !== "paused" ? "status-error" : STATUS_DOT[c.status]}`} aria-hidden="true" />
                          {stop && c.status !== "paused" ? "Stopped by safety stop" : STATUS_LABEL[c.status]}
                        </p>
                        <p className="mt-0.5 text-sm text-base-content/65 md:hidden">
                          {c.approved} approved, {c.invited} invited, {c.replied} replied
                        </p>
                      </td>
                      {[c.found, c.approved, c.invited, c.accepted, c.messaged, c.replied].map((n, i) => (
                        <td key={i} className="hidden text-right text-sm md:table-cell">
                          {n}
                        </td>
                      ))}
                      <td className="text-right">
                        <button type="button" className="btn btn-xs btn-ghost border-base-300">
                          {c.status === "paused" ? "Resume" : "Pause"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-8">
          <section aria-labelledby="a-usage">
            <h2 id="a-usage" className="mb-3 text-lg font-semibold">
              Today's usage
            </h2>
            <ul className="flex flex-col gap-4 rounded-box bg-base-200 p-4">
              {USAGE.map((u) => {
                const full = u.used >= u.limit;
                return (
                  <li key={u.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{u.label}</span>
                      <span className="nums text-sm">
                        <span className="font-semibold">{u.used}</span>
                        <span className="text-base-content/65"> of {u.limit}</span>
                      </span>
                    </div>
                    <progress
                      className={`progress mt-1.5 h-1.5 ${full ? "progress-warning" : "progress-primary"}`}
                      value={u.used}
                      max={u.limit}
                    />
                    {u.week && (
                      <p className="nums mt-1 text-sm text-base-content/65">
                        {u.week.used} of {u.week.limit} this week
                      </p>
                    )}
                    {u.note && <p className="mt-1 text-sm text-base-content/80">{u.note}</p>}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="a-activity">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 id="a-activity" className="text-lg font-semibold">
                What the app did
              </h2>
              <button type="button" className="link text-sm link-hover" onClick={() => go("activity")}>
                Activity log
              </button>
            </div>
            <ol className="flex flex-col gap-2.5 text-sm">
              {ACTIVITY.slice(0, 5).map((a) => (
                <li key={a.time} className="grid grid-cols-[3rem_1fr] gap-2">
                  <span className="nums text-base-content/60">{a.time}</span>
                  <span className={a.result === "deferred" ? "text-base-content/70" : ""}>{a.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}

function NeedRow(props: {
  readonly count: number;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly primary?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4">
      <span className="nums flex size-11 shrink-0 items-center justify-center rounded-box bg-accent text-xl font-semibold text-accent-content">
        {props.count}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-base-content/65">{props.detail}</p>
      </div>
      <button type="button" className={`btn btn-sm ${props.primary ? "btn-primary" : ""}`} onClick={props.onClick}>
        {props.action}
      </button>
    </div>
  );
}

const STEPS = [0, 5, 6, 7, 8] as const;

function Approvals() {
  const q = useQueue();
  const cols = "lg:grid-cols-[3.25rem_minmax(13rem,1fr)_minmax(0,1.15fr)_minmax(0,1.25fr)_8.75rem]";
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-[1.75rem] leading-tight font-semibold">Approval queue</h1>
        <p className="nums text-base-content/65">
          {q.pending.length} waiting, {q.decisions.size} decided
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-box bg-base-200 px-3 py-3">
        <span className="text-sm">Minimum score</span>
        <div className="join">
          {STEPS.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn join-item btn-sm nums ${q.minScore === s ? "btn-neutral" : "bg-base-100"}`}
              onClick={() => q.setMinScore(s)}
            >
              {s === 0 ? "Any" : `${s}+`}
            </button>
          ))}
        </div>
        <span className="nums text-sm text-base-content/65">Showing {q.shown.length}</span>
        <button type="button" className="btn btn-sm btn-primary w-full sm:ml-auto sm:w-auto" onClick={q.approveAll} disabled={q.pending.length === 0}>
          <IconCheck />
          Approve all {q.pending.length} shown
        </button>
      </div>

      <div className="mt-4 rounded-box border border-base-300" role="table" aria-label="Prospects waiting for approval">
        <div role="row" className={`hidden gap-4 border-b border-base-300 px-4 py-2 text-sm text-base-content/65 lg:grid ${cols}`}>
          <span role="columnheader">Score</span>
          <span role="columnheader">Person</span>
          <span role="columnheader">Why the AI picked them</span>
          <span role="columnheader">First message</span>
          <span role="columnheader" className="text-right">
            Decide
          </span>
        </div>
        {q.shown.map((p) => {
          const d = q.decisions.get(p.id);
          return (
            <div
              key={p.id}
              role="row"
              className={`grid grid-cols-[2.75rem_1fr] gap-x-3 gap-y-2.5 border-b border-base-300 px-4 py-4 last:border-b-0 lg:gap-x-4 ${cols} ${
                d === "approved" ? "bg-primary/6" : d === "rejected" ? "opacity-55" : ""
              }`}
            >
              <span
                role="cell"
                className={`nums flex size-10 items-center justify-center rounded-field text-lg font-semibold ${SCORE_CHIP[scoreTone(p.score)]}`}
                aria-label={`Score ${p.score} of 10`}
              >
                {p.score}
              </span>
              <div role="cell" className="min-w-0">
                <p className="font-semibold">{p.name}</p>
                <p className="text-sm">{p.headline}</p>
                <p className="text-sm text-base-content/65">
                  {p.company}, {p.location}
                </p>
              </div>
              <p role="cell" className="col-span-2 text-sm lg:col-span-1">
                {p.reason}
              </p>
              <p role="cell" className="col-span-2 border-l-2 border-base-300 pl-3 text-sm text-base-content/80 lg:col-span-1 lg:line-clamp-4">
                {p.message}
              </p>
              <div role="cell" className="col-span-2 flex items-start gap-2 lg:col-span-1 lg:flex-col lg:items-stretch">
                <button
                  type="button"
                  className={`btn btn-sm flex-1 lg:flex-none ${d === "approved" ? "btn-primary" : "btn-outline border-primary/50 text-primary"}`}
                  onClick={() => q.decide(p, "approved")}
                >
                  <IconCheck />
                  {d === "approved" ? "Approved" : "Approve"}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm flex-1 lg:flex-none ${d === "rejected" ? "btn-neutral" : "btn-ghost border-base-300"}`}
                  onClick={() => q.decide(p, "rejected")}
                >
                  <IconX />
                  {d === "rejected" ? "Rejected" : "Reject"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
