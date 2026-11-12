// PROTOTYPE helpers shared by the three variants: queue state and a few inline icons. No layout here.
import { useMemo, useState } from "react";
import { PROSPECTS, type Prospect, type ScreenKey } from "./data";

export interface VariantProps {
  readonly screen: ScreenKey;
  readonly go: (screen: ScreenKey) => void;
  readonly stop: boolean;
}

export type Decision = "approved" | "rejected";

/** Approve/reject live in memory only. Nothing is sent anywhere. */
export function useQueue(initialMin = 0) {
  const [decisions, setDecisions] = useState<ReadonlyMap<number, Decision>>(new Map());
  const [minScore, setMinScore] = useState(initialMin);
  const shown = useMemo(() => PROSPECTS.filter((p) => p.score >= minScore), [minScore]);
  const pending = shown.filter((p) => !decisions.has(p.id));
  const decide = (p: Prospect, d: Decision) =>
    setDecisions((prev) => {
      const next = new Map(prev);
      if (next.get(p.id) === d) next.delete(p.id);
      else next.set(p.id, d);
      return next;
    });
  const approveAll = () =>
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const p of shown) if (!next.has(p.id)) next.set(p.id, "approved");
      return next;
    });
  return { decisions, minScore, setMinScore, shown, pending, decide, approveAll };
}

interface IconProps {
  readonly className?: string;
}

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

export function IconCheck({ className = "size-4" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconX({ className = "size-4" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconMenu({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconHome({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconInbox({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </svg>
  );
}

export function IconFlag({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 20V4M6 5h10l-2 3.5 2 3.5H6" />
    </svg>
  );
}

export function IconList({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
    </svg>
  );
}

export function IconDots({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />
    </svg>
  );
}

export function IconStop({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z" />
      <path d="M12 8v5M12 16.5h.01" />
    </svg>
  );
}

/** A screen that is not part of this prototype. */
export function NotBuilt({ title }: { readonly title: string }) {
  return (
    <div className="py-16">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-base-content/70">This screen is not part of the layout prototype.</p>
    </div>
  );
}
