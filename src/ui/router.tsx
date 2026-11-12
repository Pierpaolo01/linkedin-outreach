import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * A small history router. The app's server answers every page path with the dashboard, so
 * addresses like /approvals work when typed or reloaded. Pages are listed in `routes.tsx`.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const currentPath = () => window.location.pathname;

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}

export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
  window.scrollTo(0, 0);
}

/** Matches "/campaigns/:id" against "/campaigns/3"; returns the params, or null. */
export function matchPath(pattern: string, path: string): Readonly<Record<string, string>> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const value = have[i] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { readonly to: string };

/** An in-app link: a real anchor (so open-in-new-tab works) that changes page without reloading. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={follow} {...rest} />;
}
