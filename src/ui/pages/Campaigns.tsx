import { useState } from "react";
import { archiveCampaign, listCampaigns, pauseCampaign, resumeCampaign, toApiError } from "../api";
import type { Campaign, DiscoveryWait } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { plural } from "../format";
import { ActionError, EmptyState, haltedBy, LoadError, QUIET_BUTTON, SECONDARY_BUTTON, SectionHead, SkeletonRows, StatusLine } from "../formParts";
import { Link } from "../router";
import { FOLLOW_ENGINE_MS, useLoad } from "../useLoad";
import { discoveryWaitSentence, FUNNEL, FUNNEL_LABEL, PAUSABLE } from "../words";
import { PAGE_TITLE_ID, PageHeader } from "./PageHeader";

/** Every campaign: status, funnel counts, Pause or Resume, Archive. Archived ones are listed apart. */
export function Campaigns() {
  const { home, refresh } = useAppData();
  // Reload whenever a campaign's status or the waiting counts change (Home is polled).
  const key = `${(home?.campaigns ?? []).map((c) => `${c.id}:${c.status}`).join(",")}|${home?.needsYou.pendingApproval ?? ""}`;
  const loaded = useLoad(listCampaigns, key, { keepPrevious: true, refreshEveryMs: FOLLOW_ENGINE_MS });
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
        lead="Each campaign finds people, scores them against who you said fits, and invites and messages the ones you approve."
        action={
          <Link to="/campaigns/new" className="btn btn-sm btn-primary">
            New campaign
          </Link>
        }
      />

      <ActionError message={error} className="mb-group" />

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the campaigns" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={4} rowClassName="h-16" />
      ) : current.length === 0 ? (
        <EmptyState title="No campaigns yet.">Start one with New campaign. Nothing is sent until you approve the people it finds.</EmptyState>
      ) : (
        <CampaignTable
          labelledBy={PAGE_TITLE_ID}
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
        <section className="mt-section" aria-labelledby="archived-campaigns">
          <SectionHead id="archived-campaigns" title="Archived">
            <button type="button" className="link mr-auto inline-flex min-h-6 items-center text-sm link-hover max-lg:min-h-11" aria-expanded={showArchived} onClick={() => setShowArchived((open) => !open)}>
              {showArchived ? "Hide" : `Show ${archived.length}`}
            </button>
          </SectionHead>
          {showArchived && <CampaignTable labelledBy="archived-campaigns" campaigns={archived} waits={new Map()} stopped={false} busyId={null} onToggle={() => undefined} />}
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
        <p className="text-base-content">Its people, the texts sent and the activity log stay. Anyone it contacted is still never contacted again.</p>
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
  /** The id of the heading that names the table. */
  readonly labelledBy: string;
}) {
  const { timeZone } = useAppData();
  return (
    // Below the funnel width each campaign is one block: its name, status and counts, then its actions in one row
    // under them, so every name starts at the same height. The explicit roles keep the table's semantics there.
    <div className="@container overflow-x-auto rounded-box border border-base-300">
      <table role="table" className="table table-sm @max-funnel:block" data-testid="campaigns-table" aria-labelledby={props.labelledBy}>
        <thead role="rowgroup" className="@max-funnel:sr-only">
          <tr role="row" className="text-muted">
            <th role="columnheader" scope="col" className="font-medium">Campaign</th>
            {FUNNEL.map((step) => (
              <th key={step} role="columnheader" scope="col" className="hidden text-right font-medium @funnel:table-cell">
                {FUNNEL_LABEL[step]}
              </th>
            ))}
            <th role="columnheader" scope="col">
              <span className="sr-only">Change the campaign</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup" className="nums @max-funnel:block">
          {props.campaigns.map((c) => {
            const halted = haltedBy(c.status, props.stopped);
            const wait = props.waits.get(c.id) ?? null;
            const busy = props.busyId === c.id;
            return (
              <tr key={c.id} role="row" data-testid="campaign-row" className="@max-funnel:block">
                <th role="rowheader" scope="row" className="text-left font-normal @funnel:min-w-42 @max-funnel:block @max-funnel:border-b-0">
                  <Link to={c.status === "draft" ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`} className="inline-flex min-h-6 items-center text-nav font-semibold hover:underline">
                    {c.name.trim() === "" ? "Untitled campaign" : c.name}
                  </Link>
                  <StatusLine status={c.status} safetyStop={props.stopped} className="mt-0.5 text-sm text-muted" testId="campaign-status" />
                  {wait !== null && <p className="mt-1 max-w-sm text-sm text-base-content">{discoveryWaitSentence(wait, timeZone)}</p>}
                  <p className="mt-0.5 text-sm text-muted @funnel:hidden">
                    {c.funnel.found} found, {c.funnel.invited} invited, {c.funnel.replied} replied
                  </p>
                </th>
                {FUNNEL.map((step) => (
                  <td key={step} role="cell" className="hidden text-right @funnel:table-cell">
                    {c.funnel[step]}
                  </td>
                ))}
                <td role="cell" className="text-right @max-funnel:block @max-funnel:pt-0">
                  <div className="flex flex-wrap justify-end gap-1.5 @max-funnel:justify-start">
                    {c.status === "draft" && (
                      <Link to={`/campaigns/${c.id}/edit`} className={`${SECONDARY_BUTTON} btn-xs`}>
                        Continue setting up
                      </Link>
                    )}
                    {(PAUSABLE.has(c.status) || c.status === "paused") && (
                      <button
                        type="button"
                        className={`${halted ? QUIET_BUTTON : SECONDARY_BUTTON} btn-xs`}
                        disabled={busy}
                        aria-busy={busy}
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
                        className={`${QUIET_BUTTON} btn-xs`}
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
