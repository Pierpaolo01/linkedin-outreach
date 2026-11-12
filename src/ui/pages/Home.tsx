import { useState } from "react";
import { listActivity, listApprovals, listCampaigns, listReview, pauseCampaign, resumeCampaign, toApiError } from "../api";
import type { Budget, BudgetKind, Campaign, Home as HomeData, Settings } from "../apiSchemas";
import { useAppData } from "../appData";
import { formatResume, formatShort, formatToday, joinWords } from "../format";
import { ActionError, haltedBy, LoadError, QUIET_BUTTON, SECONDARY_BUTTON, StatusLine } from "../formParts";
import { IconCheck } from "../icons";
import { Link } from "../router";
import { FOLLOW_ENGINE_MS, useLoad } from "../useLoad";
import { FUNNEL, FUNNEL_LABEL, PAUSABLE, plainMessage } from "../words";
import { PageHeader } from "./PageHeader";

/** Home: what needs the user, the campaigns, today's usage against each limit, and what the app did. */
export function Home() {
  const { home, homeError, refresh, timeZone } = useAppData();
  const now = new Date();
  return (
    <>
      <PageHeader title="Home" aside={formatToday(timeZone, now)} />
      {home === undefined && homeError !== undefined ? (
        <LoadError what="Home" message={homeError.message} onRetry={refresh} />
      ) : home === undefined ? (
        <div className="mt-10 flex justify-center">
          <span className="loading loading-dots loading-md" aria-label="Loading" />
        </div>
      ) : (
        <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-w-0 flex-col gap-8">
            <NeedsYou home={home} />
            <Campaigns home={home} />
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            <Usage home={home} />
            <RecentActivity home={home} />
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------ needs you

function NeedsYou({ home }: { readonly home: HomeData }) {
  const { pendingApproval, needsReview } = home.needsYou;
  // Who is waiting, for the sentences. Reloads whenever the counts change.
  const approvals = useLoad(() => listApprovals({ pageSize: 200 }), `approvals-${pendingApproval}`, { keepPrevious: true });
  const review = useLoad(() => listReview({ pageSize: 20 }), `review-${needsReview}`, { keepPrevious: true });

  const byCampaign = new Map<string, number>();
  for (const item of approvals.data?.items ?? []) byCampaign.set(item.campaignName, (byCampaign.get(item.campaignName) ?? 0) + 1);
  const approvalDetail =
    byCampaign.size === 0 ? undefined : `${joinWords([...byCampaign].map(([name, n]) => `${n} in ${name}`))}.`;
  const reviewNames = (review.data?.items ?? []).map((item) => item.person.fullName);
  const reviewDetail =
    reviewNames.length === 0 ? undefined : `${joinWords(reviewNames.length > 3 ? [...reviewNames.slice(0, 3), `${reviewNames.length - 3} more`] : reviewNames)}.`;

  return (
    <section aria-labelledby="needs-you">
      <h2 id="needs-you" className="mb-3 text-lg font-semibold">
        Needs you
      </h2>
      <div className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100" data-testid="needs-you">
        {pendingApproval === 0 && needsReview === 0 ? (
          <div className="flex items-center gap-4 px-4 py-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-box bg-score-high text-primary">
              <IconCheck className="size-5" />
            </span>
            <div>
              <p className="font-medium">Nothing needs you right now.</p>
              <p className="text-sm text-base-content/65">New prospects to approve and people held for review will show up here.</p>
            </div>
          </div>
        ) : (
          <>
            {pendingApproval > 0 && (
              <NeedRow
                count={pendingApproval}
                sentence={`${pendingApproval === 1 ? "prospect is" : "prospects are"} waiting for your approval.`}
                detail={approvalDetail}
                action="Open queue"
                to="/approvals"
                primary
              />
            )}
            {needsReview > 0 && (
              <NeedRow
                count={needsReview}
                sentence={`${needsReview === 1 ? "person is" : "people are"} held for review.`}
                detail={reviewDetail}
                action="Open review"
                to="/review"
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function NeedRow(props: {
  readonly count: number;
  readonly sentence: string;
  readonly detail: string | undefined;
  readonly action: string;
  readonly to: string;
  readonly primary?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4">
      <span
        className="nums flex size-11 shrink-0 items-center justify-center rounded-box bg-accent text-xl font-semibold text-accent-content"
        aria-hidden="true"
      >
        {props.count}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium">
          <span className="sr-only">{props.count} </span>
          {props.sentence}
        </p>
        {props.detail !== undefined && <p className="text-sm text-base-content/65">{props.detail}</p>}
      </div>
      <Link to={props.to} className={props.primary === true ? "btn btn-sm btn-primary" : `${SECONDARY_BUTTON} btn-sm`}>
        {props.action}
      </Link>
    </div>
  );
}

// ------------------------------------------------------------ campaigns

function Campaigns({ home }: { readonly home: HomeData }) {
  const { refresh } = useAppData();
  // Reload the funnels whenever Home's campaigns or counts change.
  const key = `${home.campaigns.map((c) => `${c.id}:${c.status}`).join(",")}|${home.needsYou.pendingApproval}`;
  const loaded = useLoad(listCampaigns, key, { keepPrevious: true, refreshEveryMs: FOLLOW_ENGINE_MS });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const stopped = home.safetyStop !== null;

  const campaigns = (loaded.data?.campaigns ?? []).filter((c) => c.status !== "archived");

  const toggle = (campaign: Campaign) => {
    setBusyId(campaign.id);
    setError(undefined);
    (campaign.status === "paused" ? resumeCampaign(campaign.id) : pauseCampaign(campaign.id))
      .then(() => {
        loaded.reload();
        refresh();
      })
      .catch((failure: unknown) => setError(`Could not change ${campaign.name}: ${toApiError(failure).message}`))
      .finally(() => setBusyId(null));
  };

  return (
    <section aria-labelledby="home-campaigns">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="home-campaigns" className="text-lg font-semibold">
          Campaigns
        </h2>
        <Link to="/campaigns" className="link text-sm link-hover">
          All campaigns
        </Link>
      </div>
      <ActionError message={error} className="mb-3" />
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the campaigns" message={loaded.error.message} onRetry={loaded.reload} className="" />
      ) : loaded.data === undefined ? (
        <div className="skeleton h-40 w-full" />
      ) : campaigns.length === 0 ? (
        <div className="rounded-box border border-base-300 px-4 py-5">
          <p className="font-medium">No campaigns yet.</p>
          <p className="text-sm text-base-content/65">A campaign finds people, scores them and, once you approve them, invites and messages them.</p>
          <Link to="/campaigns/new" className="btn btn-sm btn-primary mt-3">
            Create a campaign
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-box border border-base-300">
          <table className="table table-sm text-sm">
            <thead>
              <tr className="text-base-content/65">
                <th className="font-medium">Campaign</th>
                {FUNNEL.map((step) => (
                  <th key={step} className="hidden text-right font-medium md:table-cell">
                    {FUNNEL_LABEL[step]}
                  </th>
                ))}
                <th>
                  <span className="sr-only">Pause or resume</span>
                </th>
              </tr>
            </thead>
            <tbody className="nums">
              {campaigns.map((c) => {
                const halted = haltedBy(c.status, stopped);
                return (
                  <tr key={c.id}>
                    <td className="py-3 md:min-w-[10.5rem]">
                      <Link to={`/campaigns/${c.id}`} className="text-nav font-semibold hover:underline">
                        {c.name}
                      </Link>
                      <StatusLine status={c.status} safetyStop={stopped} className="mt-0.5 text-sm text-base-content/65" />
                      <p className="mt-0.5 text-sm text-base-content/65 md:hidden">
                        {c.funnel.found} found, {c.funnel.invited} invited, {c.funnel.replied} replied
                      </p>
                    </td>
                    {FUNNEL.map((step) => (
                      <td key={step} className="hidden text-right text-sm md:table-cell">
                        {c.funnel[step]}
                      </td>
                    ))}
                    <td className="text-right">
                      {(PAUSABLE.has(c.status) || c.status === "paused") && (
                        <button
                          type="button"
                          className={`${halted ? QUIET_BUTTON : SECONDARY_BUTTON} btn-xs`}
                          disabled={busyId === c.id}
                          onClick={() => toggle(c)}
                          aria-label={`${c.status === "paused" ? "Resume" : "Pause"} ${c.name}`}
                        >
                          {busyId === c.id && <span className="loading loading-spinner loading-xs" />}
                          {c.status === "paused" ? "Resume" : "Pause"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ usage

const BUDGET_LABEL: Readonly<Record<BudgetKind, string>> = {
  invite: "Invites",
  message: "Messages",
  profile_view: "Profile views",
  discovery_page: "Discovery pages",
  withdraw: "Withdrawals",
};
const BUDGET_ORDER = ["invite", "message", "profile_view", "discovery_page", "withdraw"] as const satisfies readonly BudgetKind[];

function usageNote(kind: BudgetKind, budget: Budget, settings: Settings | undefined, timeZone: string, now: Date): string | undefined {
  // A spent budget is never "paused": pausing is the user's choice on one campaign. It may be spent
  // below today's number when the week's invite limit or LinkedIn's own limit blocks invites.
  if (!budget.open) return `Limit reached${budget.resumesAt === null ? "" : `, resumes ${formatResume(budget.resumesAt, timeZone, now)}`}`;
  if (kind === "invite" && settings !== undefined && settings.warmUp.enabled && budget.limit < settings.limits.invitesPerDay) {
    return `Warm-up: today's allowance, rising to ${settings.limits.invitesPerDay} a day`;
  }
  return undefined;
}

function Usage({ home }: { readonly home: HomeData }) {
  const { settings, timeZone } = useAppData();
  const now = new Date();
  return (
    <section aria-labelledby="home-usage">
      <h2 id="home-usage" className="mb-3 text-lg font-semibold">
        Today&rsquo;s usage
      </h2>
      <ul className="flex flex-col gap-4 rounded-box bg-base-200 p-4" data-testid="usage">
        {BUDGET_ORDER.map((kind) => {
          const budget = home.usage[kind];
          const full = !budget.open;
          const note = usageNote(kind, budget, settings, timeZone, now);
          return (
            <li key={kind} data-testid={`usage-${kind}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span>{BUDGET_LABEL[kind]}</span>
                <span className="nums text-sm">
                  <span className="font-semibold">{budget.used}</span>
                  <span className="text-base-content/65"> of {budget.limit}</span>
                </span>
              </div>
              <progress
                className={`progress mt-1.5 h-1.5 ${full ? "progress-warning" : "progress-primary"}`}
                value={Math.min(budget.used, budget.limit)}
                max={Math.max(budget.limit, 1)}
                aria-label={`${BUDGET_LABEL[kind]}: ${budget.used} of ${budget.limit} used today`}
              />
              {note !== undefined && <p className={`mt-1 text-sm ${full ? "text-base-content/80" : "text-base-content/65"}`}>{note}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------ activity

function RecentActivity({ home }: { readonly home: HomeData }) {
  const { timeZone } = useAppData();
  // A new line usually comes with a change in the counts or usage; reload then.
  const key = JSON.stringify([home.needsYou, BUDGET_ORDER.map((k) => home.usage[k].used), home.safetyStop?.raisedAt ?? null]);
  const loaded = useLoad(() => listActivity({ pageSize: 6 }), key, { keepPrevious: true, refreshEveryMs: FOLLOW_ENGINE_MS });
  const now = new Date();
  const items = loaded.data?.items ?? [];
  return (
    <section aria-labelledby="home-activity">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="home-activity" className="text-lg font-semibold">
          What the app did
        </h2>
        <Link to="/activity" className="link text-sm link-hover">
          Activity log
        </Link>
      </div>
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the activity log" message={loaded.error.message} onRetry={loaded.reload} className="" />
      ) : loaded.data === undefined ? (
        <div className="skeleton h-28 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-base-content/65">Nothing yet. Each invite, message and check will be listed here.</p>
      ) : (
        <ol className="flex flex-col gap-2.5 text-sm">
          {items.map((item) => (
            <li key={item.id} className="grid grid-cols-[3.25rem_1fr] gap-2">
              <span className="nums text-base-content/60">{formatShort(item.at, timeZone, now)}</span>
              <span className={item.level === "error" ? "text-error" : item.level === "warning" ? "text-base-content/70" : ""}>
                {plainMessage(item.message)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
