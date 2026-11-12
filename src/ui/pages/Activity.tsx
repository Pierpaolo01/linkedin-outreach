import { useId, useState } from "react";
import { listActivity, listCampaigns } from "../api";
import type { ActivityItem, Page } from "../apiSchemas";
import { useAppData } from "../appData";
import { formatToday } from "../format";
import { LoadError, Pager } from "../formParts";
import { useLoad } from "../useLoad";
import { formatStamp, plainMessage } from "../words";
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
      <PageHeader title="Activity log" aside={formatToday(timeZone, new Date())} />
      <p className="mt-2 max-w-2xl text-base-content/75">Everything the app did and noticed, newest first. Times are in {timeZone.replace(/_/g, " ")}.</p>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-box bg-base-200 px-3 py-3">
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
              className={`btn join-item btn-sm ${level === value ? "btn-neutral" : "bg-base-100"}`}
              onClick={() => {
                setLevel(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label htmlFor={campaignFilter} className="text-sm">
          Campaign
        </label>
        <select
          id={campaignFilter}
          className="select select-sm w-auto max-w-[16rem] bg-base-100"
          value={campaignId ?? ""}
          onChange={(event) => {
            setCampaignId(event.target.value === "" ? null : Number(event.target.value));
            setPage(1);
          }}
        >
          <option value="">All campaigns</option>
          {(campaigns.data?.campaigns ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the activity log" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <div className="skeleton mt-4 h-72 w-full" />
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-box border border-base-300 px-5 py-6" data-testid="activity-empty">
          <p className="font-medium">{level === "problems" ? "No warnings or errors." : "Nothing in the log yet."}</p>
          <p className="mt-1 text-base-content/65">
            {level === "problems" ? "When something goes wrong or needs a look, it is listed here." : "Each invite, message and check is listed here."}
          </p>
        </div>
      ) : (
        <>
          <ol className="mt-4 divide-y divide-base-300 rounded-box border border-base-300" data-testid="activity-list">
            {items.map((item) => {
              const campaign = item.campaignId === null ? undefined : names.get(item.campaignId);
              return (
                <li
                  key={item.id}
                  data-testid="activity-line"
                  data-level={item.level}
                  className={`grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)_12rem] ${
                    item.level === "warning" ? "shadow-[inset_3px_0_0_0_var(--color-warning)]" : item.level === "error" ? "shadow-[inset_3px_0_0_0_var(--color-error)]" : ""
                  }`}
                >
                  <span className="nums text-base-content/60">{formatStamp(item.at, timeZone)}</span>
                  <span className={item.level === "error" ? "text-error" : ""}>
                    {item.level === "warning" && <span className="mr-1.5 font-medium">Warning:</span>}
                    {item.level === "error" && <span className="mr-1.5 font-medium">Error:</span>}
                    {plainMessage(item.message)}
                  </span>
                  <span className="truncate text-base-content/60 sm:text-right">{campaign ?? ""}</span>
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
