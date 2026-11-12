import { getStats } from "../api";
import type { Stats as StatsData } from "../apiSchemas";
import { useAppData } from "../appData";
import { EmptyState, LoadError, StatusLine } from "../formParts";
import { Link } from "../router";
import { useLoad } from "../useLoad";
import { formatHours } from "../words";
import { PageHeader } from "./PageHeader";

/** Below this many, a percentage says more about chance than about the campaign. */
const ENOUGH = 5;

type Row = StatsData["campaigns"][number];

/** "60%", or "not enough data yet" when the count behind it is too small to mean much. */
function Rate({ value, part, whole, of }: { readonly value: number | null; readonly part: number; readonly whole: number; readonly of: string }) {
  if (value === null || whole < ENOUGH) {
    return (
      <>
        <p className="text-muted" data-testid="not-enough">
          not enough data yet
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
  const replyLabel = rows[0]?.replyRate.label ?? "replies seen before the follow-up";

  return (
    <>
      <PageHeader
        title="Stats"
        lead={`How each campaign is doing. A rate shows once at least ${ENOUGH} people are behind it. Replies are counted only until the follow-up is sent.`}
      />
      {loaded.status === "error" ? (
        <LoadError what="the stats" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <div className="skeleton h-56 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState title="No campaigns yet.">Stats appear once a campaign has sent invites.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-box border border-base-300">
          <table className="table table-sm" data-testid="stats-table">
            <thead>
              <tr className="align-bottom text-muted">
                <th className="font-medium">Campaign</th>
                <th className="font-medium">Accepted your invite</th>
                <th className="font-medium">{replyLabel}</th>
                <th className="font-medium">Median time to accept</th>
                <th className="text-right font-medium">Invites withdrawn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <StatsRow key={row.campaignId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StatsRow({ row }: { readonly row: Row }) {
  const { home } = useAppData();
  return (
    <tr data-testid="stats-row" className="align-top">
      <td>
        <Link to={`/campaigns/${row.campaignId}`} className="font-semibold hover:underline">
          {row.name}
        </Link>
        <StatusLine status={row.status} safetyStop={home?.safetyStop != null} className="text-muted" />
      </td>
      <td>
        <Rate value={row.acceptanceRate} part={row.accepted} whole={row.invitesSent} of="invited" />
      </td>
      <td>
        <Rate value={row.replyRate.value} part={row.replies} whole={row.firstMessagesSent} of="messaged" />
      </td>
      <td>
        {row.medianHoursToAccept === null ? (
          <p className="text-muted">No acceptances yet</p>
        ) : (
          <p className="nums text-lg font-semibold">{formatHours(row.medianHoursToAccept)}</p>
        )}
      </td>
      <td className="nums text-right text-lg font-semibold">{row.invitesWithdrawn}</td>
    </tr>
  );
}
