import { useId, useState } from "react";
import { listActivity, listCampaigns } from "../api";
import type { ActivityItem, Page } from "../apiSchemas";
import { useAppData } from "../appData";
import { formatToday } from "../format";
import { ActivityMessage, CampaignSelect, LevelMark, EmptyState, LoadError, Pager, SECONDARY_BUTTON, SkeletonRows, TOOLBAR } from "../formParts";
import { useLoad } from "../useLoad";
import { formatStamp } from "../words";
import { PageHeader } from "./PageHeader";

const PAGE_SIZE = 50;
/** The most the app sends in one answer. */
const MAX_PAGE = 200;

type Level = "all" | "problems";

/** Up to `count` of the newest lines at one level (several requests when more than one answer holds). */
async function newest(level: "warning" | "error", campaignId: number | null, count: number): Promise<Page<ActivityItem>> {
  const items: ActivityItem[] = [];
  let total = 0;
  for (let page = 1; items.length < count; page += 1) {
    const answer = await listActivity({ level, campaignId, page, pageSize: MAX_PAGE });
    total = answer.total;
    items.push(...answer.items);
    if (answer.items.length < MAX_PAGE) break;
  }
  return { page: 1, pageSize: count, total, items };
}

/**
 * One page of warnings and errors together. The app filters by one level at a time, so both lists
 * are read up to this page and merged, newest first.
 */
async function problemsPage(campaignId: number | null, page: number): Promise<Page<ActivityItem>> {
  const upTo = page * PAGE_SIZE;
  const [warnings, errors] = await Promise.all([newest("warning", campaignId, upTo), newest("error", campaignId, upTo)]);
  const merged = [...warnings.items, ...errors.items].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
  return { page, pageSize: PAGE_SIZE, total: warnings.total + errors.total, items: merged.slice((page - 1) * PAGE_SIZE, upTo) };
}

/** Everything the app did, newest first, filtered by campaign and by level; times in the app's time zone. */
export function Activity() {
  const { timeZone } = useAppData();
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [level, setLevel] = useState<Level>("all");
  const [page, setPage] = useState(1);
  const campaignFilter = useId();
  const campaigns = useLoad(listCampaigns, "campaigns");
  const loaded = useLoad(
    () => (level === "all" ? listActivity({ campaignId, page, pageSize: PAGE_SIZE }) : problemsPage(campaignId, page)),
    `${campaignId ?? "all"}|${level}|${page}`,
    { keepPrevious: true },
  );
  const names = new Map((campaigns.data?.campaigns ?? []).map((c) => [c.id, c.name]));
  const items = loaded.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Activity log"
        aside={formatToday(timeZone, new Date())}
        lead={`Everything the app did and noticed, newest first. Times are in ${timeZone.replace(/_/g, " ")}.`}
      />

      <div className={`${TOOLBAR} mb-group`}>
        <div className="join" role="group" aria-label="Show">
          {(
            [
              ["all", "Everything"],
              ["problems", "Warnings and errors"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={level === value}
              className={`${level === value ? "btn btn-neutral" : SECONDARY_BUTTON} join-item btn-sm`}
              onClick={() => {
                setLevel(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {/* The label and its select wrap to the next line together. */}
        <div className="inline-flex flex-wrap items-center gap-x-4 gap-y-3">
          <label htmlFor={campaignFilter} className="text-sm">
            Campaign
          </label>
          <CampaignSelect
            id={campaignFilter}
            campaigns={campaigns.data?.campaigns ?? []}
            value={campaignId}
            onChange={(id) => {
              setCampaignId(id);
              setPage(1);
            }}
          />
        </div>
      </div>

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the activity log" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={6} rowClassName="h-5" />
      ) : items.length === 0 ? (
        <EmptyState title={level === "problems" ? "No warnings or errors." : "Nothing in the log yet."} testId="activity-empty">
          {level === "problems" ? "When something goes wrong or needs a look, it is listed here." : "Each invite, message and check is listed here."}
        </EmptyState>
      ) : (
        <>
          <ol className="divide-y divide-base-300 rounded-box border border-base-300" data-testid="activity-list">
            {items.map((item) => {
              const campaign = item.campaignId === null ? undefined : names.get(item.campaignId);
              return (
                <li
                  key={item.id}
                  data-testid="activity-line"
                  data-level={item.level}
                  className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)_12rem]"
                >
                  {/*
                   * A warning's triangle or an error's dot ends the time column, so every line's text starts at one edge.
                   * One line high and at the top of the row, so the time and its mark sit on a wrapped message's first line.
                   */}
                  <span className="nums flex h-lh items-center gap-2 self-start text-muted sm:justify-between">
                    {formatStamp(item.at, timeZone)}
                    <LevelMark level={item.level} />
                  </span>
                  <ActivityMessage level={item.level} message={item.message} />
                  <span className="truncate text-muted sm:text-right">{campaign ?? ""}</span>
                </li>
              );
            })}
          </ol>
          <Pager page={page} pageSize={PAGE_SIZE} total={loaded.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
