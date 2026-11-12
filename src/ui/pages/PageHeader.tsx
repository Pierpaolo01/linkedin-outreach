import type { ReactNode } from "react";

/**
 * The title block every page starts with: the page name with a short fact on the right, then an optional
 * lead paragraph with an optional action beside it. It owns the space under it (`block`, 24px), so a page's
 * first block never sets its own top margin.
 */
export function PageHeader(props: { readonly title: string; readonly aside?: ReactNode; readonly lead?: ReactNode; readonly action?: ReactNode }) {
  return (
    <header className="mb-block">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="text-title font-semibold">{props.title}</h1>
        {props.aside !== undefined && <div className="nums text-muted">{props.aside}</div>}
      </div>
      {(props.lead !== undefined || props.action !== undefined) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          {props.lead !== undefined && <p className="max-w-2xl">{props.lead}</p>}
          {props.action}
        </div>
      )}
    </header>
  );
}
