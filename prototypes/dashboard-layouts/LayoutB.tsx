// PROTOTYPE layout B, "Review deck": a top bar (a bottom dock on the phone), a Home that reads
// as a short briefing, and an approval queue that shows one prospect at a time, driven by the keyboard.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
import {
  IconCheck,
  IconDots,
  IconFlag,
  IconHome,
  IconInbox,
  IconList,
  IconStop,
  IconX,
  NotBuilt,
  useQueue,
  type VariantProps,
} from "./shared";

export function LayoutB({ screen, go, stop }: VariantProps) {
  const session = stop ? SESSION.stop : SESSION.ok;
  const tab = (key: ScreenKey, label: string, count?: number) => (
    <li key={key}>
      <button type="button" className={`rounded-field ${screen === key ? "bg-base-content/8 font-semibold" : ""}`} onClick={() => go(key)}>
        {label}
        {count !== undefined && <span className="badge badge-sm nums border-0 bg-accent text-accent-content">{count}</span>}
      </button>
    </li>
  );

  return (
    <div className="min-h-screen bg-base-200 pb-24 lg:pb-0">
      <header className="sticky top-0 z-30 border-b border-base-300 bg-base-100">
        <div className="navbar mx-auto min-h-14 max-w-[1280px] px-4">
          <div className="navbar-start w-auto">
            <span className="text-lg font-semibold">Outreach</span>
          </div>
          <nav className="navbar-center mx-auto hidden lg:flex" aria-label="Screens">
            <ul className="menu menu-horizontal gap-1 p-0">
              {tab("home", "Home")}
              <li>
                <details>
                  <summary className={`rounded-field ${screen === "campaigns" || screen === "campaign" ? "bg-base-content/8 font-semibold" : ""}`}>
                    Campaigns
                  </summary>
                  <ul className="z-40 w-60 bg-base-100 shadow-md">
                    <li>
                      <button type="button" onClick={() => go("campaigns")}>
                        All campaigns
                      </button>
                    </li>
                    {CAMPAIGNS.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => go("campaign")}>
                          {c.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
              {tab("approvals", "Approval queue", PROSPECTS.length)}
              {tab("review", "Needs review", NEEDS_REVIEW.length)}
              {tab("activity", "Activity log")}
              {tab("stats", "Stats")}
              {tab("settings", "Settings")}
            </ul>
          </nav>
          <div className="navbar-end ml-auto w-auto">
            <span
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${
                stop ? "bg-error text-error-content" : "bg-success/12 text-success"
              }`}
            >
              <span className={`status ${stop ? "bg-error-content" : "status-success"}`} aria-hidden="true" />
              {session.label}
            </span>
          </div>
        </div>
      </header>

      {stop && (
        <div role="alert" className="bg-error text-error-content">
          <div className="mx-auto flex max-w-[1280px] flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
            <IconStop className="hidden size-7 shrink-0 sm:block" />
            <div className="min-w-0">
              <p className="font-semibold">Safety stop. All LinkedIn activity is stopped.</p>
              <p className="text-error-content/90">{SESSION.stop.banner}</p>
            </div>
            <button type="button" className="btn btn-sm shrink-0 border-0 bg-error-content text-error sm:ml-auto">
              Re-check
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1280px] px-4 py-6 lg:py-10">
        {screen === "home" ? (
          <Home go={go} stop={stop} />
        ) : screen === "approvals" ? (
          <Deck />
        ) : (
          <NotBuilt title={SCREENS.find((s) => s.key === screen)?.label ?? "Screen"} />
        )}
      </main>

      <nav className="dock dock-md z-30 border-t border-base-300 bg-base-100 lg:hidden" aria-label="Screens">
        <DockButton label="Home" active={screen === "home"} onClick={() => go("home")}>
          <IconHome />
        </DockButton>
        <DockButton label="Queue" count={PROSPECTS.length} active={screen === "approvals"} onClick={() => go("approvals")}>
          <IconInbox />
        </DockButton>
        <DockButton label="Review" count={NEEDS_REVIEW.length} active={screen === "review"} onClick={() => go("review")}>
          <IconFlag />
        </DockButton>
        <DockButton label="Activity" active={screen === "activity"} onClick={() => go("activity")}>
          <IconList />
        </DockButton>
        <div className="dropdown dropdown-top dropdown-end flex h-full flex-1 flex-col items-center justify-center">
          <div tabIndex={0} role="button" className="flex flex-col items-center gap-px">
            <IconDots />
            <span className="dock-label">More</span>
          </div>
          <ul tabIndex={-1} className="menu dropdown-content z-40 mb-2 w-56 rounded-box bg-base-100 shadow-md">
            <li>
              <button type="button" onClick={() => go("campaigns")}>
                Campaigns
              </button>
            </li>
            <li>
              <button type="button" onClick={() => go("campaign")}>
                Campaign detail
              </button>
            </li>
            <li>
              <button type="button" onClick={() => go("stats")}>
                Stats
              </button>
            </li>
            <li>
              <button type="button" onClick={() => go("settings")}>
                Settings
              </button>
            </li>
          </ul>
        </div>
      </nav>
    </div>
  );
}

function DockButton(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <button type="button" className={props.active ? "dock-active text-primary" : ""} onClick={props.onClick}>
      <span className="indicator">
        {props.count !== undefined && (
          <span className="indicator-item badge badge-xs nums border-0 bg-accent text-accent-content">{props.count}</span>
        )}
        {props.children}
      </span>
      <span className="dock-label">{props.label}</span>
    </button>
  );
}

function Home({ go, stop }: { readonly go: (s: ScreenKey) => void; readonly stop: boolean }) {
  return (
    <div className="flex flex-col gap-10">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <div>
          <p className="text-base-content/65">{TODAY}</p>
          <h1 className="mt-2 max-w-[26ch] text-3xl leading-tight font-semibold sm:text-[2.6rem]">
            {PROSPECTS.length} people are waiting for your yes or no, and {NEEDS_REVIEW.length} need a closer look.
          </h1>
          {stop && (
            <p className="mt-3 max-w-[60ch] text-base-content/80">
              You can still approve and reject. Nothing is sent to LinkedIn until the safety stop is cleared.
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => go("approvals")}>
              Start reviewing
            </button>
            <button type="button" className="btn btn-lg border-base-300 bg-base-100" onClick={() => go("review")}>
              Open needs review
            </button>
          </div>
        </div>
        <div className={`rounded-box p-5 ${stop ? "bg-error/10" : "bg-base-100"}`}>
          <p className="flex items-center gap-2 font-semibold">
            <span className={`status status-lg ${stop ? "status-error" : "status-success"}`} aria-hidden="true" />
            LinkedIn: {(stop ? SESSION.stop : SESSION.ok).label}
          </p>
          <p className="mt-1 text-base-content/75">{(stop ? SESSION.stop : SESSION.ok).line}</p>
          <p className="mt-3 text-sm text-base-content/65">
            {(stop ? SESSION.stop : SESSION.ok).checked}. {stop ? "Nothing runs until you clear the stop." : "Working until 18:00. Next action in about 2 minutes."}
          </p>
        </div>
      </section>

      <section aria-labelledby="b-today">
        <h2 id="b-today" className="text-lg font-semibold">
          Today against your limits
        </h2>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {USAGE.map((u) => {
            const pct = Math.round((u.used / u.limit) * 100);
            const full = u.used >= u.limit;
            return (
              <li key={u.key} className="flex items-center gap-4 rounded-box bg-base-100 p-4 lg:flex-col lg:items-start">
                <div className="relative shrink-0">
                <span className="absolute inset-0 rounded-full border-[5px] border-base-200" aria-hidden="true" />
                <div
                  className={`radial-progress nums text-sm font-semibold ${full ? "text-warning" : "text-primary"}`}
                  style={{ "--value": pct, "--size": "4rem", "--thickness": "5px" } as CSSProperties}
                  aria-valuenow={pct}
                  role="progressbar"
                >
                  <span className="text-base-content">
                    {u.used}/{u.limit}
                  </span>
                </div>
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{u.label}</p>
                  {u.week && (
                    <p className="nums text-sm text-base-content/65">
                      {u.week.used} of {u.week.limit} this week
                    </p>
                  )}
                  {u.note && <p className="text-sm text-base-content/75">{u.note}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="b-campaigns">
          <h2 id="b-campaigns" className="text-lg font-semibold">
            Active campaigns
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {CAMPAIGNS.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-2 rounded-box bg-base-100 p-4 text-left hover:bg-base-100/70"
                  onClick={() => go("campaign")}
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold">{c.name}</span>
                    <span className={`text-sm ${stop && c.status !== "paused" ? "text-error" : "text-base-content/65"}`}>
                      {stop && c.status !== "paused" ? "Stopped by safety stop" : STATUS_LABEL[c.status]}
                    </span>
                  </span>
                  <Funnel steps={[c.found, c.approved, c.invited, c.accepted, c.messaged, c.replied]} />
                  <span className="nums text-sm text-base-content/70">
                    {c.found} found, {c.invited} invited, {c.accepted} accepted, {c.replied} replied
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="b-did">
          <h2 id="b-did" className="text-lg font-semibold">
            What the app did today
          </h2>
          <ol className="mt-4 border-l-2 border-base-300">
            {ACTIVITY.map((a) => (
              <li key={a.time} className="relative grid grid-cols-[3.5rem_1fr] gap-2 py-2 pl-5">
                <span
                  className={`absolute top-[0.9rem] -left-[5px] size-2 rounded-full ${a.result === "deferred" ? "bg-warning" : "bg-primary"}`}
                  aria-hidden="true"
                />
                <span className="nums text-base-content/60">{a.time}</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

/** Six-step funnel as stepped bars, widest at "found". */
function Funnel({ steps }: { readonly steps: readonly number[] }) {
  const max = Math.max(...steps, 1);
  return (
    <span className="flex h-2 gap-1" aria-hidden="true">
      {steps.map((n, i) => (
        <span key={i} className="flex-1 overflow-hidden rounded-full bg-base-200">
          <span className="block h-full rounded-full bg-primary/70" style={{ width: `${(n / max) * 100}%` }} />
        </span>
      ))}
    </span>
  );
}

function Deck() {
  const q = useQueue();
  const [currentId, setCurrentId] = useState<number>(PROSPECTS[0]?.id ?? 0);
  const current = q.shown.find((p) => p.id === currentId) ?? q.pending[0] ?? q.shown[0];
  const position = current ? q.shown.indexOf(current) + 1 : 0;

  const advance = (fromId: number) => {
    const idx = q.shown.findIndex((p) => p.id === fromId);
    const after = [...q.shown.slice(idx + 1), ...q.shown.slice(0, idx)];
    const next = after.find((p) => !q.decisions.has(p.id));
    if (next) setCurrentId(next.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!current || t?.closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (k === "a") {
        q.decide(current, "approved");
        advance(current.id);
      } else if (k === "r") {
        q.decide(current, "rejected");
        advance(current.id);
      } else if (k === "s" || k === "j") {
        advance(current.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const decided = q.shown.filter((p) => q.decisions.has(p.id)).length;

  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-0">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl font-semibold sm:text-[1.75rem]">Approval queue</h1>
          <p className="nums text-base-content/65">
            {decided} of {q.shown.length} decided. Nothing is sent until you approve.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:w-auto">
          <label className="flex items-center gap-3 text-sm">
            <span className="whitespace-nowrap">
              Minimum score <span className="nums font-semibold">{q.minScore}</span>
            </span>
            <input
              type="range"
              min={0}
              max={10}
              value={q.minScore}
              onChange={(e) => q.setMinScore(Number(e.target.value))}
              className="range range-xs range-neutral w-32"
            />
          </label>
          <button type="button" className="btn btn-sm border-base-300 bg-base-100" onClick={q.approveAll} disabled={q.pending.length === 0}>
            Approve all {q.pending.length} shown
          </button>
        </div>
      </div>

      <ol className="flex gap-1" aria-label="Queue progress">
        {q.shown.map((p) => {
          const d = q.decisions.get(p.id);
          return (
            <li
              key={p.id}
              className={`h-1.5 flex-1 rounded-full ${
                d === "approved" ? "bg-primary" : d === "rejected" ? "bg-base-content/35" : p.id === current?.id ? "bg-accent" : "bg-base-300"
              }`}
            />
          );
        })}
      </ol>

      {current ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <article className="rounded-box bg-base-100 p-5 sm:p-8 lg:self-start">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="nums text-sm text-base-content/65">
                  {position} of {q.shown.length}, {current.campaign}
                </p>
                <h2 className="mt-2 text-2xl leading-tight font-semibold sm:text-[2rem]">{current.name}</h2>
                <p className="mt-1 text-lg">{current.headline}</p>
                <p className="text-base-content/65">
                  {current.company}, {current.location}
                </p>
              </div>
              <ScoreDial score={current.score} />
            </div>

            <div className="mt-7 grid gap-7 xl:grid-cols-2">
              <section>
                <h3 className="text-sm font-semibold text-base-content/70">Why the AI scored {current.score}</h3>
                <p className="mt-2 text-lg leading-relaxed">{current.reason}</p>
              </section>
              <section>
                <h3 className="text-sm font-semibold text-base-content/70">First message, after they accept</h3>
                <div className="chat chat-end mt-1">
                  <div className="chat-bubble max-w-full bg-base-200 text-base-content">{current.message}</div>
                </div>
              </section>
            </div>

            <div className="fixed inset-x-0 bottom-16 z-20 flex gap-2 border-t border-base-300 bg-base-100 px-4 py-3 lg:static lg:mt-8 lg:border-0 lg:p-0">
              <button
                type="button"
                className="btn btn-lg flex-1 border-base-300 lg:flex-none"
                onClick={() => {
                  q.decide(current, "rejected");
                  advance(current.id);
                }}
              >
                <IconX className="size-5" />
                Reject
                <kbd className="kbd kbd-sm hidden lg:inline-flex">R</kbd>
              </button>
              <button type="button" className="btn btn-lg btn-ghost hidden lg:inline-flex" onClick={() => advance(current.id)}>
                Skip
                <kbd className="kbd kbd-sm">S</kbd>
              </button>
              <button
                type="button"
                className="btn btn-lg btn-primary flex-[1.4] lg:ml-auto lg:flex-none lg:px-10"
                onClick={() => {
                  q.decide(current, "approved");
                  advance(current.id);
                }}
              >
                <IconCheck className="size-5" />
                Approve
                <kbd className="kbd kbd-sm hidden border-primary-content/30 bg-primary-content/15 text-primary-content lg:inline-flex">A</kbd>
              </button>
            </div>
          </article>

          <aside aria-labelledby="b-next">
            <h2 id="b-next" className="mb-3 font-semibold">
              In this batch
            </h2>
            <ul className="flex flex-col gap-1">
              {q.shown.map((p) => {
                const d = q.decisions.get(p.id);
                const isCurrent = p.id === current.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setCurrentId(p.id)}
                      className={`flex w-full items-center gap-3 rounded-field px-3 py-2 text-left ${
                        isCurrent ? "bg-base-100 ring-2 ring-accent" : "hover:bg-base-100"
                      }`}
                    >
                      <span className={`nums w-6 text-center font-semibold ${scoreTone(p.score) === "low" ? "text-base-content/50" : ""}`}>
                        {p.score}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{p.name}</span>
                        <span className="block truncate text-sm text-base-content/65">{p.company}</span>
                      </span>
                      {d === "approved" && <IconCheck className="size-4 text-primary" />}
                      {d === "rejected" && <IconX className="size-4 text-base-content/50" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 hidden text-sm text-base-content/65 lg:block">
              <kbd className="kbd kbd-xs">A</kbd> approve, <kbd className="kbd kbd-xs">R</kbd> reject, <kbd className="kbd kbd-xs">S</kbd> skip
            </p>
          </aside>
        </div>
      ) : (
        <p className="rounded-box bg-base-100 p-8">No prospects at or above this score.</p>
      )}
    </div>
  );
}

function ScoreDial({ score }: { readonly score: number }) {
  const tone = scoreTone(score);
  return (
    <div
      className={`radial-progress nums shrink-0 ${tone === "high" ? "text-primary" : tone === "mid" ? "text-warning" : "text-base-content/40"}`}
      style={{ "--value": score * 10, "--size": "5.25rem", "--thickness": "6px" } as CSSProperties}
      aria-valuenow={score * 10}
      role="progressbar"
      aria-label={`Score ${score} of 10`}
    >
      <span className="text-base-content">
        <span className="text-3xl font-semibold">{score}</span>
        <span className="text-sm text-base-content/60">/10</span>
      </span>
    </div>
  );
}
