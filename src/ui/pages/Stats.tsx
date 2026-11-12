import { getStats } from "../api";
import type { Stats as StatsData } from "../apiSchemas";
import { useAppData } from "../appData";
import { EmptyState, LoadError, SkeletonRows, StatusLine } from "../formParts";
import { Link } from "../router";
import { useLoad } from "../useLoad";
import { formatHours } from "../words";
import { PageHeader } from "./PageHeader";

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Below this many, a percentage says more about chance than about the campaign. */
const ENOUGH = 5;

type Row = StatsData["campaigns"][number];

/*
 * The table needs a box of 50rem (`--container-stats`) for its five columns. In a narrower box each campaign is
 * one block: its name and status, then the four measures two to a line, each under its column's name. The
 * explicit roles keep the table's semantics when its parts are displayed as blocks; the visible names are for the eye.
 */
const STACK_MEASURE = "@max-stats:border-0 @max-stats:p-0 @max-stats:text-left";

function StackLabel({ children }: { readonly children: string }) {
  return (
    <span className="hidden text-caption font-normal text-muted @max-stats:mb-0.5 @max-stats:block" aria-hidden="true">
      {children}
    </span>
  );
}

/** "60%", or "Not enough data yet" when the count behind it is too small to mean much. */
function Rate({ value, part, whole, of }: { readonly value: number | null; readonly part: number; readonly whole: number; readonly of: string }) {
  if (value === null || whole < ENOUGH) {
    return (
      <>
        <p className="text-muted" data-testid="not-enough">
          Not enough data yet
        </p>
        <p className="nums text-sm text-muted">
          {part} of {whole} {of}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="nums text-2xl font-semibold">{Math.round(value * 100)}%</p>
      <p className="nums text-sm text-muted">
        {part} of {whole} {of}
      </p>
    </>
  );
}

/** Per campaign: acceptance rate, replies seen before the follow-up, median time to accept, invites withdrawn. */
export function Stats() {
  const loaded = useLoad(getStats, "stats");
  const rows = loaded.data?.campaigns ?? [];
  // The server names this measure in lower case ("replies seen before the follow-up"); as a column head it starts with a capital.
  const replyLabel = capitalised(rows[0]?.replyRate.label ?? "replies seen before the follow-up");

  return (
    <>
      <PageHeader
        title="Stats"
        lead={`How each campaign is doing. A rate shows once at least ${ENOUGH} people are behind it. Replies are counted only until the follow-up is sent.`}
      />
      {loaded.status === "error" ? (
        <LoadError what="the stats" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={4} rowClassName="h-14" />
      ) : rows.length === 0 ? (
        <EmptyState title="No campaigns yet.">Stats appear once a campaign has sent invites.</EmptyState>
      ) : (
        <div className="@container overflow-x-auto rounded-box border border-base-300">
          <table role="table" className="table table-sm @max-stats:block" data-testid="stats-table" aria-label="Stats per campaign">
            <thead role="rowgroup" className="@max-stats:sr-only">
              <tr role="row" className="align-bottom text-muted">
                <th role="columnheader" scope="col" className="font-medium">Campaign</th>
                <th role="columnheader" scope="col" className="font-medium">Accepted your invite</th>
                <th role="columnheader" scope="col" className="font-medium">{replyLabel}</th>
                <th role="columnheader" scope="col" className="font-medium">Median time to accept</th>
                <th role="columnheader" scope="col" className="text-right font-medium">Invites withdrawn</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-stats:block">
              {rows.map((row) => (
                <StatsRow key={row.campaignId} row={row} replyLabel={replyLabel} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StatsRow({ row, replyLabel }: { readonly row: Row; readonly replyLabel: string }) {
  const { home } = useAppData();
  return (
    <tr role="row" data-testid="stats-row" className="align-top @max-stats:grid @max-stats:grid-cols-2 @max-stats:gap-x-4 @max-stats:gap-y-3 @max-stats:px-4 @max-stats:py-3 @max-stats:not-last:border-b @max-stats:not-last:border-base-300">
      <th role="rowheader" scope="row" className="text-left font-normal @max-stats:col-span-2 @max-stats:border-0 @max-stats:p-0">
        <Link to={`/campaigns/${row.campaignId}`} className="inline-flex min-h-6 items-center font-semibold hover:underline">
          {row.name}
        </Link>
        <StatusLine status={row.status} safetyStop={home?.safetyStop != null} className="text-muted" />
      </th>
      <td role="cell" className={STACK_MEASURE}>
        <StackLabel>Accepted your invite</StackLabel>
        <Rate value={row.acceptanceRate} part={row.accepted} whole={row.invitesSent} of="invited" />
      </td>
      <td role="cell" className={STACK_MEASURE}>
        <StackLabel>{replyLabel}</StackLabel>
        <Rate value={row.replyRate.value} part={row.replies} whole={row.firstMessagesSent} of="messaged" />
      </td>
      <td role="cell" className={STACK_MEASURE}>
        <StackLabel>Median time to accept</StackLabel>
        {row.medianHoursToAccept === null ? (
          <p className="text-muted">No acceptances yet</p>
        ) : (
          <p className="nums text-lg font-semibold">{formatHours(row.medianHoursToAccept)}</p>
        )}
      </td>
      <td role="cell" className={`nums text-right text-lg font-semibold ${STACK_MEASURE}`}>
        <StackLabel>Invites withdrawn</StackLabel>
        {row.invitesWithdrawn}
      </td>
    </tr>
  );
}
