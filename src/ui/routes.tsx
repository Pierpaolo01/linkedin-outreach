import type { ReactNode } from "react";
import { Activity } from "./pages/Activity";
import { Approvals } from "./pages/Approvals";
import { CampaignDetail } from "./pages/CampaignDetail";
import { Campaigns } from "./pages/Campaigns";
import { CampaignWizard } from "./pages/CampaignWizard";
import { Home } from "./pages/Home";
import { NeedsReview } from "./pages/NeedsReview";
import { Settings } from "./pages/Settings";
import { Stats } from "./pages/Stats";

/**
 * Every page of the dashboard, first match wins. To add a page: write it in `pages/` and add its
 * entry here. The sidebar links to all eight destinations of spec section 10.
 */
export interface Route {
  /** A path like "/campaigns/:id"; `:name` parts arrive in `params`. */
  readonly path: string;
  /** The browser tab title. */
  readonly title: string;
  readonly render: (params: Readonly<Record<string, string>>) => ReactNode;
}

export const ROUTES: readonly Route[] = [
  { path: "/", title: "Home", render: () => <Home /> },
  { path: "/approvals", title: "Approval queue", render: () => <Approvals /> },
  { path: "/review", title: "Needs review", render: () => <NeedsReview /> },
  { path: "/campaigns", title: "Campaigns", render: () => <Campaigns /> },
  // The wizard keeps its form when a new campaign's address changes to its draft's; both render it in the same place.
  { path: "/campaigns/new", title: "New campaign", render: () => <CampaignWizard /> },
  { path: "/campaigns/:id/edit", title: "New campaign", render: ({ id }) => <CampaignWizard id={id ?? ""} /> },
  { path: "/campaigns/:id", title: "Campaign", render: ({ id }) => <CampaignDetail key={id} id={id ?? ""} /> },
  { path: "/activity", title: "Activity log", render: () => <Activity /> },
  { path: "/stats", title: "Stats", render: () => <Stats /> },
  { path: "/settings", title: "Settings", render: () => <Settings /> },
];
