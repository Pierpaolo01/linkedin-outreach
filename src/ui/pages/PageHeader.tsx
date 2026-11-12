import type { ReactNode } from "react";

/** The title row every page starts with: the page name, and a short fact on the right. */
export function PageHeader({ title, aside }: { readonly title: string; readonly aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h1 className="text-[1.75rem] leading-tight font-semibold">{title}</h1>
      {aside !== undefined && <div className="nums text-base-content/65">{aside}</div>}
    </div>
  );
}
