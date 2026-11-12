// PROTOTYPE layout C, "One inbox": a single reading column. Everything that needs the user is one
// list at the top, everything the app handled by itself sits below it, other screens live in a menu.
import type { ReactNode } from "react";
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
  scoreTone,
  type ScreenKey,
} from "./data";
import { IconCheck, IconMenu, IconX, NotBuilt, useQueue, type VariantProps } from "./shared";

const SCORE_TEXT = { high: "text-primary", mid: "text-[#9a6a12]", low: "text-base-content/45" } as const;

export function LayoutC({ screen, go, stop }: VariantProps) {
  const session = stop ? SESSION.stop : SESSION.ok;
  return (
    <div className="min-h-screen bg-base-100">
      <header className="border-b border-base-300">
        <div className="mx-auto flex max-w-[46rem] items-center gap-3 px-4 py-3">
          <button type="button" className="text-lg font-semibold" onClick={() => go("home")}>
            Outreach
          </button>
          <span className={`ml-auto flex items-center gap-2 text-sm ${stop ? "font-semibold text-error" : "text-base-content/75"}`}>
            <span className={`status ${stop ? "status-error" : "status-success"}`} aria-hidden="true" />
            {session.label}
          </span>
          <div className="dropdown dropdown-end">
            <div tabIndex={0} role="button" className="btn btn-sm btn-ghost gap-2 border-base-300">
              <IconMenu className="size-4" />
              Screens
            </div>
            <ul tabIndex={-1} className="menu dropdown-content z-40 mt-2 w-60 rounded-box border border-base-300 bg-base-100 shadow-md">
              {SCREENS.map((s) => (
                <li key={s.key}>
                  <button type="button" className={screen === s.key ? "menu-active" : ""} onClick={() => go(s.key)}>
                    {s.key === "home" ? "Inbox (Home)" : s.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[46rem] px-4 pt-6 pb-16 sm:pt-10">
        {screen === "home" ? (
          <Inbox go={go} stop={stop} />
        ) : screen === "approvals" ? (
          <ApprovalThread go={go} />
        ) : (
          <NotBuilt title={SCREENS.find((s) => s.key === screen)?.label ?? "Screen"} />
        )}
      </main>
    </div>
  );
}

function Inbox({ go, stop }: { readonly go: (s: ScreenKey) => void; readonly stop: boolean }) {
  const needs = 1 + NEEDS_REVIEW.length + (stop ? 1 : 0);
  const top = [...PROSPECTS].sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    <>
      <p className="text-base-content/65">{TODAY}</p>
      <h1 className="mt-1 text-[2rem] leading-tight font-semibold">
        {needs} {needs === 1 ? "thing needs" : "things need"} you
      </h1>
      <p className="mt-2 text-base-content/75">
        {stop
          ? "LinkedIn activity is stopped. Approving and rejecting still work; nothing is sent until the stop is cleared."
          : "Connected to LinkedIn. Working until 18:00, next action in about 2 minutes."}
      </p>

      <ul className="mt-6 flex flex-col">
        {stop && (
          <Item time="10:44" mark="bg-error" tint="bg-error/8">
            <p className="text-lg font-semibold text-error">Safety stop: LinkedIn is asking for a security check</p>
            <p className="mt-1">{SESSION.stop.banner}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-error">
                Re-check
              </button>
              <button type="button" className="btn btn-sm btn-ghost border-base-300">
                Open the dedicated window
              </button>
            </div>
          </Item>
        )}
        <Item time="10:38" mark="bg-accent">
          <p className="text-lg font-semibold">{PROSPECTS.length} prospects to approve</p>
          <p className="mt-1 text-base-content/75">5 from Hotel owners, Rome and 3 from Local trades, Milan.</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {top.map((p) => (
              <li key={p.id} className="flex items-baseline gap-3">
                <span className={`nums w-5 text-right font-semibold ${SCORE_TEXT[scoreTone(p.score)]}`}>{p.score}</span>
                <span className="min-w-0 truncate">
                  {p.name}, <span className="text-base-content/65">{p.headline}</span>
                </span>
              </li>
            ))}
            <li className="pl-8 text-sm text-base-content/65">and {PROSPECTS.length - top.length} more</li>
          </ul>
          <button type="button" className="btn btn-sm btn-primary mt-4" onClick={() => go("approvals")}>
            Review all {PROSPECTS.length}
          </button>
        </Item>
        {NEEDS_REVIEW.map((r) => (
          <Item key={r.name} time={r.since} mark="bg-accent">
            <p className="text-lg font-semibold">{r.name} is held for review</p>
            <p className="mt-1">{r.reason}</p>
            <p className="text-sm text-base-content/65">{r.campaign}</p>
            <button type="button" className="btn btn-sm mt-3 border-base-300 bg-base-100" onClick={() => go("review")}>
              Look at it
            </button>
          </Item>
        ))}
      </ul>

      <h2 className="mt-12 text-lg font-semibold">Handled by the app</h2>
      <ul className="mt-3 flex flex-col">
        <Item time="10:30" mark="bg-base-300" quiet>
          <p className="font-medium">Discovery is waiting for tomorrow</p>
          <p className="text-base-content/75">The daily limit of 10 discovery pages is used. It resumes tomorrow at 09:00 by itself.</p>
        </Item>
        {CAMPAIGNS.map((c) => (
          <Item key={c.id} time="" mark="bg-base-300" quiet>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <button type="button" className="font-medium hover:underline" onClick={() => go("campaign")}>
                {c.name}
              </button>
              <span className="flex items-center gap-3 text-sm">
                <span className={stop && c.status !== "paused" ? "text-error" : "text-base-content/65"}>
                  {stop && c.status !== "paused" ? "Stopped by safety stop" : STATUS_LABEL[c.status]}
                </span>
                <button type="button" className="link link-hover">
                  {c.status === "paused" ? "Resume" : "Pause"}
                </button>
              </span>
            </div>
            <p className="text-base-content/75">{c.today}</p>
          </Item>
        ))}
      </ul>

      <h2 className="mt-12 text-lg font-semibold">Today against your limits</h2>
      <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
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
              <progress className={`progress mt-1.5 h-1.5 ${full ? "progress-warning" : "progress-primary"}`} value={u.used} max={u.limit} />
              {(u.week ?? u.note) && (
                <p className="nums mt-0.5 text-sm text-base-content/65">
                  {u.week ? `${u.week.used} of ${u.week.limit} this week` : u.note}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-12 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">What the app did</h2>
        <button type="button" className="link text-sm link-hover" onClick={() => go("activity")}>
          Activity log
        </button>
      </div>
      <ol className="mt-3 flex flex-col gap-2">
        {ACTIVITY.map((a) => (
          <li key={a.time} className="grid grid-cols-[3.25rem_1fr] gap-2">
            <span className="nums text-base-content/60">{a.time}</span>
            <span>{a.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Item(props: {
  readonly time: string;
  readonly mark: string;
  readonly tint?: string;
  readonly quiet?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li className={`grid grid-cols-[3rem_1fr] gap-x-3 border-b border-base-300 py-4 sm:grid-cols-[3.5rem_1fr] ${props.tint ?? ""}`}>
      <span className="nums flex items-start gap-2 pt-1 text-sm text-base-content/60">
        <span className={`mt-0.5 h-4 w-1 shrink-0 rounded-full ${props.mark}`} aria-hidden="true" />
        {props.time}
      </span>
      <div className={`min-w-0 ${props.tint ? "pr-3" : ""}`}>{props.children}</div>
    </li>
  );
}

const MINS = [6, 7, 8] as const;

function ApprovalThread({ go }: { readonly go: (s: ScreenKey) => void }) {
  const q = useQueue();
  return (
    <>
      <button type="button" className="link text-sm link-hover" onClick={() => go("home")}>
        Back to inbox
      </button>
      <h1 className="mt-2 text-[2rem] leading-tight font-semibold">
        {q.pending.length} {q.pending.length === 1 ? "prospect" : "prospects"} to approve
      </h1>
      <p className="mt-1 text-base-content/75">Approved people get an invite within your limits. Rejected people are never contacted.</p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <span className="text-sm">Minimum score</span>
        <form className="filter" onReset={() => q.setMinScore(0)}>
          <input className="btn btn-sm btn-square" type="reset" value="×" aria-label="Any score" />
          {MINS.map((m) => (
            <input
              key={m}
              className="btn btn-sm nums"
              type="radio"
              name="c-min"
              aria-label={`${m} or more`}
              onChange={() => q.setMinScore(m)}
            />
          ))}
        </form>
      </div>

      <ul className="mt-4 flex flex-col">
        {q.shown.map((p) => {
          const d = q.decisions.get(p.id);
          return (
            <li
              key={p.id}
              className={`grid grid-cols-[2.5rem_1fr] gap-x-3 border-b border-base-300 py-5 sm:grid-cols-[3rem_1fr_auto] sm:gap-x-4 ${
                d === "rejected" ? "opacity-50" : ""
              }`}
            >
              <span
                className={`nums text-[2rem] leading-none font-semibold ${SCORE_TEXT[scoreTone(p.score)]}`}
                aria-label={`Score ${p.score} of 10`}
              >
                {p.score}
              </span>
              <div className="min-w-0">
                <p className="text-lg leading-snug font-semibold">
                  {p.name}
                  {d === "approved" && <span className="badge badge-sm ml-2 border-0 bg-primary/12 align-middle text-primary">Approved</span>}
                </p>
                <p>{p.headline}</p>
                <p className="text-sm text-base-content/65">
                  {p.company}, {p.location}
                </p>
                <p className="mt-2 text-base-content/85">{p.reason}</p>
                <blockquote className="mt-2 rounded-box bg-base-200 px-3 py-2 text-sm text-base-content/85">
                  <span className="font-medium text-base-content">First message: </span>
                  {p.message}
                </blockquote>
              </div>
              <div className="col-span-2 mt-3 flex gap-2 sm:col-span-1 sm:mt-0 sm:flex-col">
                <button
                  type="button"
                  className={`btn btn-sm flex-1 sm:flex-none ${d === "approved" ? "btn-primary" : "btn-outline border-primary/50 text-primary"}`}
                  onClick={() => q.decide(p, "approved")}
                >
                  <IconCheck />
                  Approve
                </button>
                <button
                  type="button"
                  className={`btn btn-sm flex-1 sm:flex-none ${d === "rejected" ? "btn-neutral" : "btn-ghost border-base-300"}`}
                  onClick={() => q.decide(p, "rejected")}
                >
                  <IconX />
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="sticky bottom-0 -mx-4 mt-4 flex flex-wrap items-center gap-3 border-t border-base-300 bg-base-100 px-4 py-3">
        <span className="nums text-sm text-base-content/75">
          {q.pending.length} still to decide, showing {q.shown.length}
        </span>
        <button type="button" className="btn btn-primary ml-auto" onClick={q.approveAll} disabled={q.pending.length === 0}>
          <IconCheck />
          Approve all {q.pending.length}
        </button>
      </div>
    </>
  );
}
