// PROTOTYPE, throwaway. Three structurally different dashboard layouts on one page.
// URL: ?v=a|b|c&screen=home|approvals&stop=1 (safety stop on)&clean=1 (hides the switcher for screenshots).
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ScreenKey } from "./data";
import { LayoutA } from "./LayoutA";
import { LayoutB } from "./LayoutB";
import { LayoutC } from "./LayoutC";
import "./index.css";

const VARIANTS = [
  { key: "a", name: "Sidebar desk", Component: LayoutA },
  { key: "b", name: "Review deck", Component: LayoutB },
  { key: "c", name: "One inbox", Component: LayoutC },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  const v = p.get("v");
  return {
    variant: (VARIANTS.some((x) => x.key === v) ? v : "a") as VariantKey,
    screen: (p.get("screen") ?? "home") as ScreenKey,
    stop: p.get("stop") === "1",
    clean: p.get("clean") === "1",
  };
}

function writeUrl(state: { variant: VariantKey; screen: ScreenKey; stop: boolean; clean: boolean }) {
  const p = new URLSearchParams();
  p.set("v", state.variant);
  p.set("screen", state.screen);
  if (state.stop) p.set("stop", "1");
  if (state.clean) p.set("clean", "1");
  window.history.replaceState(null, "", `?${p.toString()}`);
}

function Prototype() {
  const [state, setState] = useState(readUrl);
  const update = useCallback((patch: Partial<typeof state>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });
  }, []);

  const index = VARIANTS.findIndex((x) => x.key === state.variant);
  const current = VARIANTS[index] ?? VARIANTS[0];
  const cycle = useCallback(
    (step: number) => {
      const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length] ?? VARIANTS[0];
      update({ variant: next.key });
    },
    [index, update],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  const { Component } = current;
  return (
    <>
      <Component key={current.key} screen={state.screen} stop={state.stop} go={(screen) => update({ screen })} />
      {!state.clean && (
        <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral px-2 py-1.5 text-sm text-neutral-content shadow-lg lg:bottom-4">
          <button type="button" className="btn btn-ghost btn-xs btn-circle text-neutral-content" onClick={() => cycle(-1)} aria-label="Previous layout">
            ‹
          </button>
          <span className="px-2 whitespace-nowrap">
            {current.key.toUpperCase()}: {current.name}
          </span>
          <button type="button" className="btn btn-ghost btn-xs btn-circle text-neutral-content" onClick={() => cycle(1)} aria-label="Next layout">
            ›
          </button>
          <label className="ml-2 flex items-center gap-1.5 whitespace-nowrap pr-2">
            <input
              type="checkbox"
              className="toggle toggle-xs toggle-error"
              checked={state.stop}
              onChange={(e) => update({ stop: e.target.checked })}
            />
            Stop
          </label>
        </div>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
);
