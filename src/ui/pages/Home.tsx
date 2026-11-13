import { useState } from "react";
import { listActivity, listApprovals, listCampaigns, listReview, pauseCampaign, resumeCampaign, toApiError } from "../api";
import type { BudgetKind, Campaign, Home as HomeData } from "../apiSchemas";
import { useAppData } from "../appData";
import { formatShort, formatToday, joinWords, unbroken } from "../format";
import { ActionError, ActivityMessage, EmptyState, LevelMark, HALTED_PAUSE, haltedBy, LoadError, SECONDARY_BUTTON, SectionHead, SkeletonRows, StatusLine } from "../formParts";
import { IconCheck } from "../icons";
import { Link } from "../router";
import { FOLLOW_ENGINE_MS, useLoad } from "../useLoad";
import { budgetNote, FUNNEL, FUNNEL_LABEL, PAUSABLE, toggleFailure, type Failure } from "../words";
import { PageHeader } from "./PageHeader";

/** Home: what needs the user, the campaigns, today's usage against each budget, and what the app did. */
export function Home() {
  const { home, homeError, refresh, timeZone } = useAppData();
  const now = new Date();
  return (
    <>
      <PageHeader title="Home" aside={formatToday(timeZone, now)} />
      {home === undefined && homeError !== undefined ? (
        <LoadError what="Home" error={homeError} onRetry={refresh} />
      ) : home === undefined ? (
        <HomeLoading />
      ) : (
        <div className="grid gap-section xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-w-0 flex-col gap-section">
            <NeedsYou home={home} />
            <Campaigns home={home} />
          </div>
          <div className="flex min-w-0 flex-col gap-section">
            <Usage home={home} />
            <RecentActivity home={home} />
          </div>
        </div>
      )}
    </>
  );
}

/** Home's shape while it loads: each section's block at about its final height, so nothing jumps when the data arrives. */
function HomeLoading() {
  const heading = <div className="skeleton mb-group h-7 w-40" />;
  return (
    <div role="status" aria-label="Loading" className="grid gap-section xl:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="flex min-w-0 flex-col gap-section" aria-hidden="true">
        <div>
          {heading}
          <SkeletonRows quiet rows={2} rowClassName="h-13" />
        </div>
        <div>
          {heading}
          <SkeletonRows quiet rows={4} rowClassName="h-16" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-section" aria-hidden="true">
        <div>
          {heading}
          <div className="skeleton h-96 w-full" />
        </div>
        <div>
          {heading}
          <div className="skeleton h-42 w-full" />
        </div>
      </div>
    </div>
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
      <SectionHead id="needs-you" title="Needs you" />
      <div className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100" data-testid="needs-you">
        {pendingApproval === 0 && needsReview === 0 ? (
          <div className="flex items-center gap-4 px-4 py-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-box bg-score-high text-primary">
              <IconCheck className="size-5" />
            </span>
            <div>
              <p className="font-medium">Nothing needs you right now.</p>
              <p className="text-sm text-muted">New prospects to approve and people held for review will show up here.</p>
            </div>
          </div>
        ) : (
          <>
            {pendingApproval > 0 && (
              <NeedRow
                count={pendingApproval}
                sentence={pendingApproval === 1 ? "Prospect waiting for your approval" : "Prospects waiting for your approval"}
                detail={approvalDetail}
                action="Open queue"
                to="/approvals"
                primary
              />
            )}
            {needsReview > 0 && (
              <NeedRow
                count={needsReview}
                sentence={needsReview === 1 ? "Person held for review" : "People held for review"}
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
        className="nums flex h-11 min-w-11 shrink-0 items-center justify-center rounded-box bg-accent px-1.5 text-xl font-semibold text-accent-content"
        aria-hidden="true"
      >
        {props.count}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-semibold">
          <span className="sr-only">{props.count} </span>
          {props.sentence}
        </p>
        {props.detail !== undefined && <p className="text-sm text-muted">{props.detail}</p>}
      </div>
      <Link to={props.to} className={`${props.primary === true ? "btn btn-sm btn-primary" : `${SECONDARY_BUTTON} btn-sm`} max-sm:w-full`}>
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
  const [error, setError] = useState<Failure | undefined>(undefined);
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
      .catch((failed: unknown) => setError(toggleFailure({ name: campaign.name, resuming: campaign.status === "paused", said: toApiError(failed) })))
      .finally(() => setBusyId(null));
  };

  return (
    <section aria-labelledby="home-campaigns">
      <SectionHead id="home-campaigns" title="Campaigns">
        <Link to="/campaigns" className="link inline-flex min-h-6 items-center text-sm link-hover max-lg:-my-2.5 max-lg:min-h-11">
          All campaigns
        </Link>
      </SectionHead>
      <ActionError message={error} className="mb-group" takeFocus />
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the campaigns" error={loaded.error} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={4} rowClassName="h-16" />
      ) : campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet."
          action={
            <Link to="/campaigns/new" className="btn btn-sm btn-primary">
              Create a campaign
            </Link>
          }
        >
          A campaign finds people, scores them and, once you approve them, invites and messages them.
        </EmptyState>
      ) : (
        <div className="@container overflow-x-auto rounded-box border border-base-300">
          {/* Below the funnel width the rows are one column: the lone "Campaign" header is for screen readers only. */}
          <table role="table" className="table table-sm" aria-labelledby="home-campaigns">
            <thead role="rowgroup" className="@max-funnel:sr-only">
              <tr role="row" className="text-muted">
                <th role="columnheader" scope="col" className="font-medium">Campaign</th>
                {FUNNEL.map((step) => (
                  <th key={step} role="columnheader" scope="col" className="hidden text-right font-medium @funnel:table-cell">
                    {FUNNEL_LABEL[step]}
                  </th>
                ))}
                <th role="columnheader" scope="col">
                  <span className="sr-only">Pause or resume</span>
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="nums">
              {campaigns.map((c) => {
                const halted = haltedBy(c.status, stopped);
                return (
                  <tr key={c.id} role="row">
                    <th role="rowheader" scope="row" className="text-left font-normal @funnel:min-w-42">
                      <Link to={`/campaigns/${c.id}`} className="inline-flex min-h-6 items-center text-nav font-semibold hover:underline max-lg:-my-2.5 max-lg:min-h-11">
                        {c.name}
                      </Link>
                      <StatusLine status={c.status} safetyStop={stopped} className="mt-0.5 text-sm text-muted" />
                      <p className="mt-0.5 text-sm text-muted @funnel:hidden">
                        {unbroken(`${c.funnel.found} found`)}, {unbroken(`${c.funnel.invited} invited`)}, {unbroken(`${c.funnel.replied} replied`)}
                      </p>
                    </th>
                    {FUNNEL.map((step) => (
                      <td key={step} role="cell" className="hidden text-right @funnel:table-cell">
                        {c.funnel[step]}
                      </td>
                    ))}
                    <td role="cell" className="text-right">
                      {(PAUSABLE.has(c.status) || c.status === "paused") && (
                        <button
                          type="button"
                          className={`${SECONDARY_BUTTON} btn-xs ${halted ? HALTED_PAUSE : ""}`}
                          disabled={busyId === c.id}
                          aria-busy={busyId === c.id}
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

function Usage({ home }: { readonly home: HomeData }) {
  const { settings, timeZone } = useAppData();
  const now = new Date();
  const warmUpTarget = settings?.warmUp.enabled === true ? settings.limits.invitesPerDay : undefined;
  return (
    <section aria-labelledby="home-usage">
      <SectionHead id="home-usage" title="Today’s usage" />
      <ul className="flex flex-col gap-4 rounded-box bg-base-200 p-4" data-testid="usage">
        {BUDGET_ORDER.map((kind) => {
          const budget = home.usage[kind];
          const full = !budget.open;
          const note = budgetNote({ kind, budget, warmUpTarget, timeZone, now });
          return (
            <li key={kind} data-testid={`usage-${kind}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span>{BUDGET_LABEL[kind]}</span>
                <span className="nums text-sm">
                  <span className="font-semibold">{budget.used}</span>
                  <span className="text-muted"> of {budget.limit}</span>
                </span>
              </div>
              {/*
               * A spent budget is quiet (not a problem): its meter is the control tone, lighter than the green bars and the
               * muted words, never amber. Its track is Desk Paper, so a meter spent below its number (the week's invite
               * budget, LinkedIn's own limit) still meets 3:1 against the track; the control-tone edge meets 3:1 on the card.
               */}
              <progress
                className={`progress mt-1.5 h-2 border border-control ${full ? "bg-base-100 text-control" : "bg-base-300 progress-primary"}`}
                value={Math.min(budget.used, budget.limit)}
                max={Math.max(budget.limit, 1)}
                aria-label={`${BUDGET_LABEL[kind]}: ${budget.used} of ${budget.limit} used today`}
              />
              {note !== undefined && <p className="mt-1 text-sm text-muted">{note}</p>}
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
  // Home's lines show no campaign beside them, so a line keeps its campaign's name (in quotes).
  const names = new Map(home.campaigns.map((c) => [c.id, c.name]));
  return (
    <section aria-labelledby="home-activity">
      <SectionHead id="home-activity" title="What the app did">
        <Link to="/activity" className="link inline-flex min-h-6 items-center text-sm link-hover max-lg:-my-2.5 max-lg:min-h-11">
          Activity log
        </Link>
      </SectionHead>
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the activity log" error={loaded.error} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <div role="status" aria-label="Loading" className="skeleton h-42 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Each invite, message and check will be listed here.</p>
      ) : (
        <ol className="flex flex-col gap-2.5 text-sm">
          {items.map((item) => (
            <li key={item.id} className="grid grid-cols-[4rem_1fr] gap-2">
              {/* One line high and at the top of the row, so the time and its mark sit on the message's first line when it wraps. */}
              <span className="nums flex h-lh items-center justify-between gap-1.5 self-start text-muted">
                {formatShort(item.at, timeZone, now)}
                <LevelMark level={item.level} />
              </span>
              <ActivityMessage level={item.level} message={item.message} campaign={item.campaignId === null ? undefined : names.get(item.campaignId)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
