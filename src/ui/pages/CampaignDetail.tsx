import { Fragment, useEffect, useId, useState } from "react";
import { getCampaign, listCampaignProspects, pauseCampaign, prospectsCsvUrl, resumeCampaign, setDoNotContact, toApiError, updateCampaign } from "../api";
import { PROSPECT_STAGES, type Campaign, type Prospect } from "../apiSchemas";
import { useAppData } from "../appData";
import { formFromCampaign, LIVE_KEYS, toFields, withoutErrors, type CampaignForm, type FieldErrors, type SetField } from "../campaignForm";
import { MessageFields, TimingFields } from "../CampaignFields";
import { ActionError, Announce, DEF_LIST, DEF_TERM, EmptyState, FilledText, haltedBy, LoadError, Notice, Pager, QUIET_BUTTON, ScoreChip, SECONDARY_BUTTON, SectionHead, SkeletonRows, StatusLine, SwitchRow, TOOLBAR } from "../formParts";
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
 * person is one block of four lines: name (with score and Profile at the right); headline and company, muted and the
 * full width of the block; stage in Ink, and the next action when there is one; the reason, muted. So the block reads
 * in steps: who (semibold), what they do (muted), where they are (Ink), why (muted).
 * The column names are not shown there: the explicit roles keep the table's semantics when its parts are laid out
 * as a grid, so every cell keeps its column's name. Until the box is 66rem (`--container-people-wide`) the table
 * hides its Company column from the eye, header and cells together (screen readers keep it), and prints the
 * company after the headline as the block does, so Person and the reason are not squeezed to three or four lines.
 * When nobody on the shown page has a next action, the Next action column is hidden from the eye the same way, so the
 * reason gets its width instead of a column of dashes.
 */
const STACK_CELL = "@max-people:min-w-0 @max-people:border-0 @max-people:p-0";

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
  const quietNext = items.every((p) => p.nextActionAt === null);

  return (
    <section className="mt-section" aria-labelledby="people">
      <SectionHead id="people" title="People">
        <a href={prospectsCsvUrl(campaign.id)} className="link inline-flex min-h-6 items-center text-sm link-hover max-lg:-my-2.5 max-lg:min-h-11">
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
                  <th role="columnheader" scope="col" className="font-medium @max-people-wide:sr-only">
                    Company
                  </th>
                  <th role="columnheader" scope="col" className="font-medium">Stage</th>
                  <th role="columnheader" scope="col" className="font-medium">Score</th>
                  <th role="columnheader" scope="col" className="min-w-56 font-medium">Why the AI scored them so</th>
                  <th role="columnheader" scope="col" className={`font-medium ${quietNext ? "sr-only" : ""}`}>
                    Next action
                  </th>
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
                      quietNext={quietNext}
                      onToggle={() => setOpen((current) => (current === p.id ? null : p.id))}
                      timeZone={timeZone}
                      now={now}
                    />
                    {open === p.id && (
                      <tr role="row" className="@max-people:block">
                        <td role="cell" colSpan={7} className="animate-appear bg-base-200/60 p-4 @max-people:block">
                          <ProspectDetail prospect={p} campaign={campaign} timeZone={timeZone} onChanged={() => setNonce((n) => n + 1)} />
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
  /** Nobody on the shown page has a next action: the column is for screen readers only. */
  readonly quietNext: boolean;
  readonly onToggle: () => void;
  readonly timeZone: string;
  readonly now: Date;
}) {
  const { prospect: p, campaign, timeZone, now } = props;
  const next = nextStepWords(p.stage, campaign);
  const stopped = p.stopReason === "replied" ? " (they replied)" : p.stopReason === "manual_takeover" ? " (you messaged them yourself)" : "";
  const { headline, company } = p.person;
  /** The block prints the company after the headline unless the headline already says it. */
  const companyAfter = company !== null && company !== "" && !(headline ?? "").includes(company);
  return (
    <tr
      role="row"
      data-testid="prospect-row"
      className={`@max-people:grid @max-people:grid-cols-[auto_minmax(0,1fr)_auto_auto] @max-people:items-start @max-people:gap-x-3 @max-people:gap-y-1.5 @max-people:px-4 @max-people:py-3 @max-people:not-last:border-b @max-people:not-last:border-base-300 ${props.open ? "bg-base-200/60" : ""}`}
    >
      <th role="rowheader" scope="row" className={`min-w-52 text-left font-normal ${STACK_CELL} @max-people:col-span-4 @max-people:col-start-1 @max-people:row-start-1`}>
        {/* In the block the score and Profile sit at the right of this line only (28px chip, 12px gaps, Profile), so the headline under it runs the full width. */}
        <div className="@max-people:min-h-7 @max-people:pr-29">
          <button
            type="button"
            className="inline-flex min-h-6 items-center gap-1 text-left font-semibold hover:underline max-lg:-my-2.5 max-lg:min-h-11"
            aria-expanded={props.open}
            onClick={props.onToggle}
          >
            {p.person.fullName}
            <IconChevron
              className={`size-3.5 shrink-0 text-muted transition-transform duration-(--duration-appear) ease-settle ${props.open ? "rotate-90" : ""}`}
            />
          </button>
        </div>
        {headline !== null && (
          <p className="text-base-content @max-people:text-muted">
            {headline}
            {companyAfter && (
              <span className="hidden text-muted @max-people-wide:inline" aria-hidden="true">
                {" "}
                · {company}
              </span>
            )}
          </p>
        )}
        {headline === null && company !== null && (
          <p className="hidden @max-people:text-muted @max-people-wide:block" aria-hidden="true">
            {company}
          </p>
        )}
        {p.person.doNotContact && <span className="badge badge-sm mt-1 border-0 bg-error/10 text-caption text-error">Do not contact</span>}
      </th>
      {/* In the block, and in a table narrower than 66rem, the company follows the headline (once, when the headline does not already name it). */}
      <td role="cell" className={`${STACK_CELL} @max-people-wide:sr-only`}>
        {company ?? <span className="text-muted">Unknown</span>}
      </td>
      <td role="cell" className={`whitespace-nowrap ${STACK_CELL} @max-people:col-start-1 @max-people:row-start-2`}>
        <span data-testid="prospect-stage">
          <StageWords stage={p.stage} extra={stopped} replied={p.stopReason === "replied"} />
        </span>
      </td>
      <td role="cell" className={`${STACK_CELL} @max-people:col-start-3 @max-people:row-start-1 @max-people:self-start`}>
        <ScoreChip score={p.score} size="sm" />
      </td>
      <td role="cell" className={`text-base-content @max-people:text-muted ${STACK_CELL} @max-people:col-span-4 @max-people:col-start-1 @max-people:row-start-3`}>
        {p.scoreReason ?? <span className="text-muted">Not scored yet</span>}
      </td>
      <td
        role="cell"
        className={`${STACK_CELL} @max-people:col-span-3 @max-people:col-start-2 @max-people:row-start-2 ${props.quietNext ? "sr-only" : p.nextActionAt === null ? "@max-people:sr-only" : ""}`}
      >
        {p.nextActionAt === null ? (
          <span className="text-muted">
            <span aria-hidden="true">–</span>
            <span className="sr-only">Nothing planned</span>
          </span>
        ) : (
          <div className="@max-people:flex @max-people:flex-wrap @max-people:gap-x-1.5">
            <span className="hidden text-muted @max-people:inline" aria-hidden="true">
              Next:
            </span>
            {next !== undefined && <p>{next}</p>}
            <p className="whitespace-nowrap text-muted">{formatNext(p.nextActionAt, timeZone, now)}</p>
          </div>
        )}
      </td>
      <td role="cell" className={`${STACK_CELL} @max-people:col-start-4 @max-people:row-start-1 @max-people:self-start`}>
        <a
          href={p.person.profileUrl}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex min-h-6 items-center gap-1 whitespace-nowrap text-base-content link-hover max-lg:-my-2.5 max-lg:min-h-11"
        >
          Profile
          <IconExternal />
          <span className="sr-only">of {p.person.fullName} on LinkedIn (opens in your browser)</span>
        </a>
      </td>
    </tr>
  );
}

/**
 * Stages that wait on the user lead the column; stages where the sequence is over step back, except a sequence
 * stopped because the person replied: that is the outcome the campaign is for, so it stays in Ink.
 */
const WAITING_STAGES: ReadonlySet<Stage> = new Set<Stage>(["pending_approval", "needs_review"]);
const CLOSED_STAGES: ReadonlySet<Stage> = new Set<Stage>(["rejected", "withdrawn", "stopped", "completed"]);

function StageWords({ stage, extra, replied }: { readonly stage: Stage; readonly extra: string; readonly replied: boolean }) {
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
    <span className={CLOSED_STAGES.has(stage) && !(stage === "stopped" && replied) ? "text-muted" : ""}>
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

function ProspectDetail(props: { readonly prospect: Prospect; readonly campaign: Campaign; readonly timeZone: string; readonly onChanged: () => void }) {
  const { prospect: p, campaign, timeZone, onChanged } = props;
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

  // Each text with the campaign's template for it, so the filled-in values are set apart (plain if it was edited since).
  const texts = [
    ["Invite note", p.texts.inviteNote, campaign.inviteNote, p.invitedAt === null ? "Not invited yet." : "Invited without a note."],
    ["First message", p.texts.firstMessage, campaign.firstMessage, "Not sent yet."],
    ["Follow-up", p.texts.followUp, campaign.followUp, "Not sent."],
  ] as const;

  return (
    <div className="grid gap-x-section gap-y-block lg:grid-cols-[minmax(0,1fr)_17rem]" data-testid="prospect-detail">
      <div className="min-w-0">
        <h3 className="font-semibold">Texts as sent</h3>
        <dl className="mt-2 flex flex-col gap-3">
          {texts.map(([label, text, template, none]) => (
            <div key={label}>
              <dt className="text-caption text-muted">{label}</dt>
              {text === null ? (
                <dd className="text-muted">{none}</dd>
              ) : (
                <dd className="border-l-2 border-base-300 pl-3 whitespace-pre-line wrap-break-word" data-testid="sent-text">
                  <FilledText text={text} template={template} />
                </dd>
              )}
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
          <dl className={`${DEF_LIST} text-sm sm:grid-cols-[12rem_minmax(0,1fr)]`} data-testid="messages-list">
            <dt className={`${DEF_TERM} text-muted`}>Invite note</dt>
            <dd className="whitespace-pre-line">{campaign.inviteNote === null || campaign.inviteNote === "" ? <span className="text-muted">No note</span> : campaign.inviteNote}</dd>
            <dt className={`${DEF_TERM} text-muted`}>First message</dt>
            <dd className="whitespace-pre-line">{campaign.firstMessage === "" ? <span className="text-muted">Not written</span> : campaign.firstMessage}</dd>
            <dt className={`${DEF_TERM} text-muted`}>Follow-up</dt>
            <dd className="whitespace-pre-line" data-testid="current-follow-up">
              {campaign.followUp === "" ? <span className="text-muted">No follow-up</span> : campaign.followUp}
            </dd>
            <dt className={`${DEF_TERM} text-muted`}>AI-written line</dt>
            <dd>{campaign.aiPersonalise ? "On" : "Off"}</dd>
            <dt className={`${DEF_TERM} text-muted`}>Waits</dt>
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
