import { Fragment, useEffect, useId, useState } from "react";
import { getCampaign, listCampaignProspects, pauseCampaign, prospectsCsvUrl, resumeCampaign, setDoNotContact, toApiError, updateCampaign } from "../api";
import { PROSPECT_STAGES, type Campaign, type Prospect } from "../apiSchemas";
import { useAppData } from "../appData";
import { formFromCampaign, LIVE_KEYS, toFields, withoutErrors, type CampaignForm, type FieldErrors, type SetField } from "../campaignForm";
import { MessageFields, TimingFields } from "../CampaignFields";
import { ActionError, Announce, EmptyState, haltedBy, LoadError, Notice, Pager, QUIET_BUTTON, ScoreChip, SECONDARY_BUTTON, SectionHead, SkeletonRows, StatusLine, SwitchRow, TOOLBAR } from "../formParts";
import { IconChevron, IconExternal } from "../icons";
import { tabTitle } from "../format";
import { Link } from "../router";
import { FOLLOW_ENGINE_MS, useLoad } from "../useLoad";
import { discoveryWaitSentence, formatNext, formatStamp, FUNNEL, FUNNEL_LABEL, LIVE, nextStepWords, PAUSABLE, POLICY_WORDS, stageWords } from "../words";
import { PageHeader } from "./PageHeader";

const PAGE_SIZE = 25;
type Stage = (typeof PROSPECT_STAGES)[number];

/*
 * The People table needs a box of 58rem (`--container-people`) for its seven columns. In a narrower box each
 * person is one block: the cells stack, each value under or beside its column's name. The explicit roles keep
 * the table's semantics when its parts are displayed as blocks; the visible names are for the eye only.
 */
const STACK_CELL = "@max-people:min-w-0 @max-people:border-0 @max-people:p-0";
const STACK_PAIR = `${STACK_CELL} @max-people:grid @max-people:grid-cols-[6rem_minmax(0,1fr)] @max-people:items-baseline @max-people:gap-x-3`;
const STACK_LABEL = "hidden text-caption text-muted @max-people:block";

function StackLabel({ children }: { readonly children: string }) {
  return (
    <span className={STACK_LABEL} aria-hidden="true">
      {children}
    </span>
  );
}

/** One campaign: its funnel and status, its people with stage and score, and its messages and timings. */
export function CampaignDetail({ id }: { readonly id: string }) {
  const campaignId = Number(id);
  const [nonce, setNonce] = useState(0);
  const loaded = useLoad(() => getCampaign(campaignId).then((r) => r.campaign), `campaign-${id}-${nonce}`, { keepPrevious: true, refreshEveryMs: FOLLOW_ENGINE_MS });
  const reload = () => setNonce((n) => n + 1);

  if (loaded.status === "error" && loaded.data === undefined) {
    return (
      <>
        <PageHeader title="Campaign" />
        <LoadError what="the campaign" message={loaded.error.message} onRetry={loaded.reload} />
      </>
    );
  }
  if (loaded.data === undefined) {
    return (
      <>
        <PageHeader title="Campaign" />
        <div role="status" aria-label="Loading">
          <div className="skeleton h-6 w-72 max-w-full" aria-hidden="true" />
          <div className="skeleton mt-group h-20 w-full" aria-hidden="true" />
          <SkeletonRows quiet rows={4} rowClassName="h-12" className="mt-section" />
        </div>
      </>
    );
  }
  return <Detail campaign={loaded.data} onChanged={reload} />;
}

function Detail({ campaign, onChanged }: { readonly campaign: Campaign; readonly onChanged: () => void }) {
  const { home, refresh, timeZone } = useAppData();
  // The tab says which campaign this is (the route only knows "Campaign" until it has loaded).
  useEffect(() => {
    document.title = tabTitle(campaign.name.trim() === "" ? "Untitled campaign" : campaign.name);
  }, [campaign.name]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const wait = home?.campaigns.find((c) => c.id === campaign.id)?.discoveryWait ?? null;
  const stopped = home?.safetyStop != null;
  const halted = haltedBy(campaign.status, stopped);

  const toggle = () => {
    setBusy(true);
    setError(undefined);
    (campaign.status === "paused" ? resumeCampaign(campaign.id) : pauseCampaign(campaign.id))
      .then(() => {
        onChanged();
        refresh();
      })
      .catch((failure: unknown) => setError(toApiError(failure).message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <PageHeader title={campaign.name} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatusLine status={campaign.status} safetyStop={stopped} className="gap-2 font-medium" testId="campaign-status" />
        {(PAUSABLE.has(campaign.status) || campaign.status === "paused") && (
          <button type="button" className={`${halted ? QUIET_BUTTON : SECONDARY_BUTTON} btn-sm`} disabled={busy} aria-busy={busy} onClick={toggle}>
            {busy && <span className="loading loading-spinner loading-xs" />}
            {campaign.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        {campaign.status === "draft" && (
          <Link to={`/campaigns/${campaign.id}/edit`} className="btn btn-sm btn-primary">
            Continue setting up
          </Link>
        )}
        <p className="text-sm text-muted">
          {campaign.discoverySource === "search" ? `From ${campaign.sourceUrls.length === 1 ? "a people search" : `${campaign.sourceUrls.length} people searches`}` : "From LinkedIn's recommendations"}
          {campaign.autoApprove ? ". Auto-approve is on" : ""}.
        </p>
      </div>
      {wait !== null && <p className="mt-2 text-sm text-base-content">{discoveryWaitSentence(wait, timeZone)}</p>}
      <ActionError message={error} className="mt-group" />

      <ol className="mt-group grid grid-cols-3 gap-px overflow-hidden rounded-box border border-base-300 bg-base-300 sm:grid-cols-6" aria-label="Funnel" data-testid="funnel">
        {FUNNEL.map((step) => (
          <li key={step} className="bg-base-100 px-4 py-3">
            <p className="nums text-2xl font-semibold">{campaign.funnel[step]}</p>
            <p className="text-sm text-muted">{FUNNEL_LABEL[step]}</p>
          </li>
        ))}
      </ol>

      <People campaign={campaign} />
      <MessagesAndTimings campaign={campaign} onSaved={onChanged} />
    </>
  );
}

// ------------------------------------------------------------ people

function People({ campaign }: { readonly campaign: Campaign }) {
  const { timeZone } = useAppData();
  const [stage, setStage] = useState<Stage | null>(null);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const filterId = useId();
  const loaded = useLoad(
    () => listCampaignProspects(campaign.id, { ...(stage === null ? {} : { stage }), page, pageSize: PAGE_SIZE }),
    `${campaign.id}|${stage ?? "all"}|${page}|${nonce}`,
    { keepPrevious: true, refreshEveryMs: FOLLOW_ENGINE_MS },
  );
  const now = new Date();
  const items = loaded.data?.items ?? [];

  return (
    <section className="mt-section" aria-labelledby="people">
      <SectionHead id="people" title="People">
        <a href={prospectsCsvUrl(campaign.id)} className="link inline-flex min-h-6 items-center text-sm link-hover">
          Download as CSV
        </a>
      </SectionHead>
      <div className={`${TOOLBAR} mb-group`}>
        <label htmlFor={filterId} className="text-sm">
          Stage
        </label>
        <select
          id={filterId}
          className="select select-sm w-auto bg-base-100"
          value={stage ?? ""}
          onChange={(event) => {
            setStage(PROSPECT_STAGES.find((s) => s === event.target.value) ?? null);
            setPage(1);
            setOpen(null);
          }}
        >
          <option value="">Every stage</option>
          {PROSPECT_STAGES.map((s) => (
            <option key={s} value={s}>
              {stageWords(s)}
            </option>
          ))}
        </select>
        <span className="nums text-sm text-muted">{loaded.data === undefined ? "" : `${loaded.data.total} ${loaded.data.total === 1 ? "person" : "people"}`}</span>
      </div>

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the people" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={4} rowClassName="h-12" />
      ) : items.length === 0 ? (
        <EmptyState title={stage === null ? "Nobody found yet." : `Nobody at the stage ${stageWords(stage).toLowerCase()}.`} testId="people-empty">
          {stage === null ? "People appear here as the campaign finds them." : "Choose another stage, or every stage."}
        </EmptyState>
      ) : (
        <>
          <div className="@container overflow-x-auto rounded-box border border-base-300">
            <table role="table" className="table table-sm @max-people:block" data-testid="people-table" aria-labelledby="people">
              <thead role="rowgroup" className="@max-people:sr-only">
                <tr role="row" className="text-muted">
                  <th role="columnheader" scope="col" className="font-medium">Person</th>
                  <th role="columnheader" scope="col" className="font-medium">Company</th>
                  <th role="columnheader" scope="col" className="font-medium">Stage</th>
                  <th role="columnheader" scope="col" className="font-medium">Score</th>
                  <th role="columnheader" scope="col" className="min-w-[14rem] font-medium">Why the AI scored them so</th>
                  <th role="columnheader" scope="col" className="font-medium">Next action</th>
                  <th role="columnheader" scope="col">
                    <span className="sr-only">LinkedIn profile</span>
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup" className="@max-people:block">
                {items.map((p) => (
                  <Fragment key={p.id}>
                    <ProspectRow
                      prospect={p}
                      campaign={campaign}
                      open={open === p.id}
                      onToggle={() => setOpen((current) => (current === p.id ? null : p.id))}
                      timeZone={timeZone}
                      now={now}
                    />
                    {open === p.id && (
                      <tr role="row" className="@max-people:block">
                        <td role="cell" colSpan={7} className="bg-base-200/60 p-4 @max-people:block">
                          <ProspectDetail prospect={p} timeZone={timeZone} onChanged={() => setNonce((n) => n + 1)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={loaded.data.page}
            pageSize={PAGE_SIZE}
            total={loaded.data.total}
            onPage={(next) => {
              setPage(next);
              setOpen(null);
            }}
          />
        </>
      )}
    </section>
  );
}

function ProspectRow(props: {
  readonly prospect: Prospect;
  readonly campaign: Campaign;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly timeZone: string;
  readonly now: Date;
}) {
  const { prospect: p, campaign, timeZone, now } = props;
  const next = nextStepWords(p.stage, campaign);
  const stopped = p.stopReason === "replied" ? " (they replied)" : p.stopReason === "manual_takeover" ? " (you messaged them yourself)" : "";
  return (
    <tr
      role="row"
      data-testid="prospect-row"
      className={`@max-people:flex @max-people:flex-col @max-people:gap-2 @max-people:px-4 @max-people:py-3 @max-people:not-last:border-b @max-people:not-last:border-base-content/5 ${props.open ? "bg-base-200/60" : ""}`}
    >
      <th role="rowheader" scope="row" className={`min-w-[10rem] text-left font-normal ${STACK_CELL}`}>
        <button
          type="button"
          className="inline-flex min-h-6 items-center gap-1 text-left font-semibold hover:underline max-lg:-my-2.5 max-lg:min-h-11"
          aria-expanded={props.open}
          onClick={props.onToggle}
        >
          {p.person.fullName}
          <IconChevron className={`size-3.5 shrink-0 text-muted ${props.open ? "rotate-90" : ""}`} />
        </button>
        {p.person.headline !== null && <p className="text-base-content">{p.person.headline}</p>}
        {p.person.doNotContact && <span className="badge badge-sm mt-1 border-0 bg-error/15 text-error">Do not contact</span>}
      </th>
      <td role="cell" className={STACK_PAIR}>
        <StackLabel>Company</StackLabel>
        <span>{p.person.company ?? <span className="text-muted">Unknown</span>}</span>
      </td>
      <td role="cell" className={`whitespace-nowrap ${STACK_PAIR} @max-people:whitespace-normal`}>
        <StackLabel>Stage</StackLabel>
        <span data-testid="prospect-stage">
          <StageWords stage={p.stage} extra={stopped} />
        </span>
      </td>
      <td role="cell" className={`${STACK_PAIR} @max-people:items-center`}>
        <StackLabel>Score</StackLabel>
        <span>
          <ScoreChip score={p.score} size="sm" />
        </span>
      </td>
      <td role="cell" className={`text-base-content ${STACK_CELL}`}>
        <StackLabel>Why the AI scored them so</StackLabel>
        <span>{p.scoreReason ?? <span className="text-muted">Not scored yet</span>}</span>
      </td>
      <td role="cell" className={`min-w-[9rem] ${STACK_PAIR}`}>
        <StackLabel>Next action</StackLabel>
        {p.nextActionAt === null ? (
          <span className="text-muted">
            <span aria-hidden="true">–</span>
            <span className="sr-only">Nothing planned</span>
          </span>
        ) : (
          <div>
            {next !== undefined && <p>{next}</p>}
            <p className="text-muted">{formatNext(p.nextActionAt, timeZone, now)}</p>
          </div>
        )}
      </td>
      <td role="cell" className={STACK_CELL}>
        <a href={p.person.profileUrl} target="_blank" rel="noreferrer" className="link inline-flex min-h-6 items-center gap-1 whitespace-nowrap text-base-content link-hover">
          Profile
          <IconExternal />
          <span className="sr-only">of {p.person.fullName} on LinkedIn (opens in your browser)</span>
        </a>
      </td>
    </tr>
  );
}

/** Stages that wait on the user lead the column; stages where the sequence is over step back. */
const WAITING_STAGES: ReadonlySet<Stage> = new Set<Stage>(["pending_approval", "needs_review"]);
const CLOSED_STAGES: ReadonlySet<Stage> = new Set<Stage>(["rejected", "withdrawn", "stopped", "completed"]);

function StageWords({ stage, extra }: { readonly stage: Stage; readonly extra: string }) {
  if (WAITING_STAGES.has(stage)) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="status status-warning" aria-hidden="true" />
        {stageWords(stage)}
        {extra}
      </span>
    );
  }
  return (
    <span className={CLOSED_STAGES.has(stage) ? "text-muted" : ""}>
      {stageWords(stage)}
      {extra}
    </span>
  );
}

const CLOSED_WORDS: Partial<Record<Stage, string>> = {
  rejected: "Rejected",
  withdrawn: "Invite withdrawn",
  stopped: "Sequence stopped",
  completed: "Finished",
};

function history(p: Prospect): readonly { readonly label: string; readonly at: string }[] {
  const events: { label: string; at: string | null }[] = [
    { label: "Found", at: p.foundAt },
    { label: "Approved", at: p.approvedAt },
    { label: "Invited", at: p.invitedAt },
    { label: "Accepted your invite", at: p.acceptanceObservedAt },
    { label: "First message sent", at: p.firstMessageSentAt },
    { label: "Reply seen", at: p.replyDetectedAt },
    { label: "Follow-up sent", at: p.followUpSentAt },
    { label: CLOSED_WORDS[p.stage] ?? "Closed", at: p.closedAt },
  ];
  return events
    .flatMap((e) => (e.at === null ? [] : [{ label: e.label, at: e.at }]))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function ProspectDetail({ prospect: p, timeZone, onChanged }: { readonly prospect: Prospect; readonly timeZone: string; readonly onChanged: () => void }) {
  const [doNotContact, setDnc] = useState(p.person.doNotContact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const switchId = useId();

  const change = (on: boolean) => {
    setBusy(true);
    setError(undefined);
    setDnc(on);
    setDoNotContact(p.person.id, on)
      .then(onChanged)
      .catch((failure: unknown) => {
        setDnc(!on);
        setError(`Could not change it: ${toApiError(failure).message}`);
      })
      .finally(() => setBusy(false));
  };

  const texts = [
    ["Invite note", p.texts.inviteNote, p.invitedAt === null ? "Not invited yet." : "Invited without a note."],
    ["First message", p.texts.firstMessage, "Not sent yet."],
    ["Follow-up", p.texts.followUp, "Not sent."],
  ] as const;

  return (
    <div className="grid gap-x-section gap-y-block lg:grid-cols-[minmax(0,1fr)_17rem]" data-testid="prospect-detail">
      <div className="min-w-0">
        <h3 className="font-semibold">Texts as sent</h3>
        <dl className="mt-2 flex flex-col gap-3">
          {texts.map(([label, text, none]) => (
            <div key={label}>
              <dt className="text-caption text-muted">{label}</dt>
              <dd className={`whitespace-pre-line wrap-break-word ${text === null ? "text-muted" : "border-l-2 border-base-300 pl-3"}`}>{text ?? none}</dd>
            </div>
          ))}
        </dl>
        {p.reviewReason !== null && (
          <Notice tone="waits" className="mt-group">
            Held for review: {p.reviewReason.replace(/_/g, " ")}
          </Notice>
        )}
      </div>
      <div className="flex flex-col gap-block">
        <div>
          <h3 className="font-semibold">History</h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {history(p).map((e) => (
              <li key={e.label} className="grid grid-cols-[6.5rem_1fr] gap-2">
                <span className="nums text-muted">{formatStamp(e.at, timeZone)}</span>
                <span>{e.label}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-box border border-base-300 bg-base-100 px-3 py-3">
          <SwitchRow
            id={switchId}
            label="Do not contact"
            checked={doNotContact}
            disabled={busy}
            onChange={change}
            hint="The app never invites or messages this person, in any campaign."
          />
          <ActionError message={error} className="mt-2" />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ messages and timings

function MessagesAndTimings({ campaign, onSaved }: { readonly campaign: Campaign; readonly onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = LIVE.has(campaign.status);

  return (
    <section className="mt-section" aria-labelledby="messages-timings">
      <SectionHead id="messages-timings" title="Messages and timings">
        {live && !editing && (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} btn-sm`}
            onClick={() => {
              setNotice(undefined);
              setEditing(true);
            }}
          >
            Edit messages and timings
          </button>
        )}
      </SectionHead>
      <Announce>{notice !== undefined && <p className="mb-group text-sm text-primary">{notice}</p>}</Announce>
      {editing ? (
        <LiveEdit
          campaign={campaign}
          onCancel={() => setEditing(false)}
          onSaved={(message) => {
            setEditing(false);
            setNotice(message);
            onSaved();
          }}
        />
      ) : (
        <div className="rounded-box border border-base-300 p-card">
          {!live && (
            <p className="mb-group text-sm text-muted">
              {campaign.status === "draft" ? "A draft is changed in its setup steps." : `A${campaign.status === "archived" ? "n archived" : " finished"} campaign cannot be changed.`}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Invite note</dt>
            <dd className="whitespace-pre-line">{campaign.inviteNote === null || campaign.inviteNote === "" ? <span className="text-muted">No note</span> : campaign.inviteNote}</dd>
            <dt className="text-muted">First message</dt>
            <dd className="whitespace-pre-line">{campaign.firstMessage === "" ? <span className="text-muted">Not written</span> : campaign.firstMessage}</dd>
            <dt className="text-muted">Follow-up</dt>
            <dd className="whitespace-pre-line" data-testid="current-follow-up">
              {campaign.followUp === "" ? <span className="text-muted">No follow-up</span> : campaign.followUp}
            </dd>
            <dt className="text-muted">AI-written line</dt>
            <dd>{campaign.aiPersonalise ? "On" : "Off"}</dd>
            <dt className="text-muted">Waits</dt>
            <dd>
              First message {campaign.acceptToMessageMinHours} to {campaign.acceptToMessageMaxHours} hours after they accept; follow-up{" "}
              {campaign.followUpDelayMinHours} to {campaign.followUpDelayMaxHours} hours after that; {POLICY_WORDS[campaign.delayPolicy]}. Unaccepted
              invites are withdrawn after {campaign.withdrawAfterDays} days.
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}

function LiveEdit({ campaign, onCancel, onSaved }: { readonly campaign: Campaign; readonly onCancel: () => void; readonly onSaved: (notice: string) => void }) {
  const [form, setForm] = useState<CampaignForm>(() => formFromCampaign(campaign));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const set: SetField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => withoutErrors(e, key));
  };

  const save = () => {
    const { fields, errors: local } = toFields(form, LIVE_KEYS);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setError("Some fields need attention. They are marked below.");
      return;
    }
    setSaving(true);
    setError(undefined);
    updateCampaign(campaign.id, fields)
      .then((result) => onSaved(result.notice ?? "Saved."))
      .catch((failure: unknown) => {
        const apiError = toApiError(failure);
        setErrors(apiError.fields);
        setError(Object.keys(apiError.fields).length > 0 ? `${apiError.message}. They are marked below.` : apiError.message);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="rounded-box border border-base-300 p-card" data-testid="live-edit">
      <Notice tone="note" className="mb-block">
        Edits apply only to steps not yet sent. Texts already sent stay as they were.
      </Notice>
      <MessageFields campaignId={campaign.id} form={form} set={set} errors={errors} />
      <h3 className="mt-section mb-group font-semibold">Timings</h3>
      <TimingFields form={form} set={set} errors={errors} />
      <ActionError message={error} className="mt-block" />
      <div className="mt-block flex gap-3">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} aria-busy={saving} onClick={save}>
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save changes
        </button>
        <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
