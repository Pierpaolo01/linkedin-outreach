/** The pages the sidebar links to by their own address. */
const OWN_ITEMS: ReadonlySet<string> = new Set(["/", "/approvals", "/review", "/campaigns", "/activity", "/stats", "/settings"]);

/**
 * The address (`to`) of the one sidebar item that is current on `path`, or undefined on an address with no page.
 * The wizard, new or a draft's (`/campaigns/:id/edit`), is within Campaigns throughout, so the current item does not
 * jump when step 1 creates the draft. A campaign's page makes its own entry current when the sidebar lists it
 * (`listed`: the ids it shows), and Campaigns otherwise (an archived campaign).
 */
export function currentNavTarget(path: string, listed: readonly number[]): string | undefined {
  if (OWN_ITEMS.has(path)) return path;
  if (path === "/campaigns/new" || /^\/campaigns\/\d+\/edit$/.test(path)) return "/campaigns";
  const campaign = /^\/campaigns\/(\d+)$/.exec(path);
  if (campaign === null) return undefined;
  return listed.includes(Number(campaign[1])) ? path : "/campaigns";
}
