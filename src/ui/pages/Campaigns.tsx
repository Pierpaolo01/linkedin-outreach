import { useState } from "react";
import { archiveCampaign, listCampaigns, pauseCampaign, resumeCampaign, toApiError } from "../api";
import type { Campaign, DiscoveryWait } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { CAMPAIGN_STATUS_DOT, CAMPAIGN_STATUS_LABEL, plural } from "../format";
import { LoadError } from "../formParts";
import { Link } from "../router";
import { useLoad } from "../useLoad";
import { discoveryWaitSentence, FUNNEL, FUNNEL_LABEL, PAUSABLE } from "../words";
import { PageHeader } from "./PageHeader";

/** Every campaign: status, funnel counts, Pause or Resume, Archive. Archived ones are listed apart. */
export function Campaigns() {
  const { home, refresh } = useAppData();
  // Reload whenever a campaign's status or the waiting counts change (Home is polled).
  const key = `${(home?.campaigns ?? []).map((c) => `${c.id}:${c.status}`).join(",")}|${home?.needsYou.pendingApproval ?? ""}`;
  const loaded = useLoad(listCampaigns, key, { keepPrevious: true });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [archiving, setArchiving] = useState<Campaign | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);
  const [showArchived, setShowArchived] = useState(false);

  const all = loaded.data?.campaigns ?? [];
  const current = all.filter((c) => c.status !== "archived");
  const archived = all.filter((c) => c.status === "archived");
  const waits = new Map((home?.campaigns ?? []).map((c) => [c.id, c.discoveryWait]));
  const stopped = home?.safetyStop != null;

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

  const archive = () => {
    if (archiving === null) return;
    setArchiveBusy(true);
    setArchiveError(undefined);
    archiveCampaign(archiving.id)
      .then(() => {
        setArchiving(null);
        loaded.reload();
        refresh();
      })
      .catch((failure: unknown) => setArchiveError(toApiError(failure).message))
      .finally(() => setArchiveBusy(false));
  };

  const running = current.filter((c) => c.status === "running").length;

  return (
    <>
      <PageHeader
        title="Campaigns"
        aside={loaded.data === undefined ? undefined : `${plural(current.length, "campaign", "campaigns")}, ${running} running`}
      />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-base-content/75">
          Each campaign finds people, scores them against who you said fits, and invites and messages the ones you approve.
        </p>
        <Link to="/campaigns/new" className="btn btn-sm btn-primary">
          New campaign
        </Link>
      </div>

      {error !== undefined && (
        <p role="alert" className="mt-4 rounded-box bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the campaigns" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <div className="skeleton mt-5 h-48 w-full" />
      ) : current.length === 0 ? (
        <div className="mt-5 rounded-box border border-base-300 px-5 py-6">
          <p className="font-medium">No campaigns yet.</p>
          <p className="mt-1 text-base-content/65">Start one with New campaign. Nothing is sent until you approve the people it finds.</p>
        </div>
      ) : (
        <CampaignTable
          campaigns={current}
          waits={waits}
          stopped={stopped}
          busyId={busyId}
          onToggle={toggle}
          onArchive={(campaign) => {
            setArchiveError(undefined);
            setArchiving(campaign);
          }}
        />
      )}

      {archived.length > 0 && (
        <section className="mt-8" aria-labelledby="archived-campaigns">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 id="archived-campaigns" className="text-lg font-semibold">
              Archived
            </h2>
            <button type="button" className="link text-sm link-hover" aria-expanded={showArchived} onClick={() => setShowArchived((open) => !open)}>
              {showArchived ? "Hide" : `Show ${archived.length}`}
            </button>
          </div>
          {showArchived && <CampaignTable campaigns={archived} waits={new Map()} stopped={false} busyId={null} onToggle={() => undefined} />}
        </section>
      )}

      <ConfirmDialog
        open={archiving !== null}
        title={`Archive ${archiving?.name ?? "this campaign"}?`}
        confirmLabel="Archive"
        tone="error"
        busy={archiveBusy}
        error={archiveError}
        onConfirm={archive}
        onCancel={() => setArchiving(null)}
      >
        <p>The campaign stops for good: nobody more is found, invited or messaged for it. This cannot be undone.</p>
        <p className="text-base-content/75">Its people, the texts sent and the activity log stay. Anyone it contacted is still never contacted again.</p>
      </ConfirmDialog>
    </>
  );
}

function CampaignTable(props: {
  readonly campaigns: readonly Campaign[];
  readonly waits: ReadonlyMap<number, DiscoveryWait | null>;
  readonly stopped: boolean;
  readonly busyId: number | null;
  readonly onToggle: (campaign: Campaign) => void;
  readonly onArchive?: (campaign: Campaign) => void;
}) {
  const { timeZone } = useAppData();
  return (
    <div className="mt-5 overflow-x-auto rounded-box border border-base-300">
      <table className="table table-sm text-sm" data-testid="campaigns-table">
        <thead>
          <tr className="text-base-content/65">
            <th className="font-medium">Campaign</th>
            {FUNNEL.map((step) => (
              <th key={step} className="hidden text-right font-medium md:table-cell">
                {FUNNEL_LABEL[step]}
              </th>
            ))}
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="nums">
          {props.campaigns.map((c) => {
            const halted = props.stopped && PAUSABLE.has(c.status);
            const wait = props.waits.get(c.id) ?? null;
            const busy = props.busyId === c.id;
            return (
              <tr key={c.id} data-testid="campaign-row">
                <td className="py-3 md:min-w-[14rem]">
                  <Link to={c.status === "draft" ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`} className="text-[0.95rem] font-semibold hover:underline">
                    {c.name.trim() === "" ? "Untitled campaign" : c.name}
                  </Link>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-base-content/65" data-testid="campaign-status">
                    <span className={`status ${halted ? "status-error" : CAMPAIGN_STATUS_DOT[c.status]}`} aria-hidden="true" />
                    {halted ? "Stopped by safety stop" : CAMPAIGN_STATUS_LABEL[c.status]}
                  </p>
                  {wait !== null && <p className="mt-1 max-w-sm text-sm text-base-content/80">{discoveryWaitSentence(wait, timeZone)}</p>}
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
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {c.status === "draft" && (
                      <Link to={`/campaigns/${c.id}/edit`} className="btn btn-xs btn-ghost border-base-300">
                        Continue setting up
                      </Link>
                    )}
                    {(PAUSABLE.has(c.status) || c.status === "paused") && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost border-base-300"
                        disabled={busy}
                        onClick={() => props.onToggle(c)}
                        aria-label={`${c.status === "paused" ? "Resume" : "Pause"} ${c.name}`}
                      >
                        {busy && <span className="loading loading-spinner loading-xs" />}
                        {c.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    )}
                    {props.onArchive !== undefined && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-base-content/70"
                        onClick={() => props.onArchive?.(c)}
                        aria-label={`Archive ${c.name}`}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
