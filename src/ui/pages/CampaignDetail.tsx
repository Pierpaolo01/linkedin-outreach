import { Fragment, useId, useState } from "react";
import { getCampaign, listCampaignProspects, pauseCampaign, prospectsCsvUrl, resumeCampaign, setDoNotContact, toApiError, updateCampaign } from "../api";
import { PROSPECT_STAGES, type Campaign, type Prospect } from "../apiSchemas";
import { useAppData } from "../appData";
import { formFromCampaign, LIVE_KEYS, toFields, withoutErrors, type CampaignForm, type FieldErrors, type SetField } from "../campaignForm";
import { MessageFields, TimingFields } from "../CampaignFields";
import { CAMPAIGN_STATUS_DOT, CAMPAIGN_STATUS_LABEL, formatScore, scoreTone } from "../format";
import { LoadError, Pager, SwitchRow } from "../formParts";
import { IconExternal } from "../icons";
import { Link } from "../router";
import { useLoad } from "../useLoad";
import { discoveryWaitSentence, formatNext, formatStamp, FUNNEL, FUNNEL_LABEL, LIVE, nextStepWords, PAUSABLE, stageWords } from "../words";
import { PageHeader } from "./PageHeader";

const PAGE_SIZE = 25;
const SCORE_CHIP = {
  high: "bg-score-high text-primary",
  mid: "bg-score-mid text-score-mid-content",
  low: "bg-base-200 text-base-content/55",
} as const;
type Stage = (typeof PROSPECT_STAGES)[number];

/** One campaign: its funnel and status, its people with stage and score, and its messages and timings. */
export function CampaignDetail({ id }: { readonly id: string }) {
  const campaignId = Number(id);
  const [nonce, setNonce] = useState(0);
  const loaded = useLoad(() => getCampaign(campaignId).then((r) => r.campaign), `campaign-${id}-${nonce}`, { keepPrevious: true });
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
        <div className="skeleton mt-6 h-24 w-full" />
        <div className="skeleton mt-6 h-72 w-full" />
      </>
    );
  }
  return <Detail campaign={loaded.data} onChanged={reload} />;
}

function Detail({ campaign, onChanged }: { readonly campaign: Campaign; readonly onChanged: () => void }) {
  const { home, refresh, timeZone } = useAppData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const wait = home?.campaigns.find((c) => c.id === campaign.id)?.discoveryWait ?? null;
  const halted = home?.safetyStop != null && PAUSABLE.has(campaign.status);

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
      <PageHeader title={campaign.name} aside={<a href={prospectsCsvUrl(campaign.id)} className="link text-sm link-hover">Download its people as CSV</a>} />

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-center gap-2 font-medium" data-testid="campaign-status">
          <span className={`status ${halted ? "status-error" : CAMPAIGN_STATUS_DOT[campaign.status]}`} aria-hidden="true" />
          {halted ? "Stopped by safety stop" : CAMPAIGN_STATUS_LABEL[campaign.status]}
        </p>
        {(PAUSABLE.has(campaign.status) || campaign.status === "paused") && (
          <button type="button" className="btn btn-sm btn-ghost border-base-300" disabled={busy} onClick={toggle}>
            {busy && <span className="loading loading-spinner loading-xs" />}
            {campaign.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        {campaign.status === "draft" && (
          <Link to={`/campaigns/${campaign.id}/edit`} className="btn btn-sm btn-primary">
            Continue setting up
          </Link>
        )}
        <p className="text-sm text-base-content/65">
          {campaign.discoverySource === "search" ? `From ${campaign.sourceUrls.length === 1 ? "a people search" : `${campaign.sourceUrls.length} people searches`}` : "From LinkedIn's recommendations"}
          {campaign.autoApprove ? ". Auto-approve is on" : ""}.
        </p>
      </div>
      {wait !== null && <p className="mt-2 text-sm text-base-content/80">{discoveryWaitSentence(wait, timeZone)}</p>}
      {error !== undefined && (
        <p role="alert" className="mt-3 rounded-box bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      <ol className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-box border border-base-300 bg-base-300 sm:grid-cols-6" aria-label="Funnel" data-testid="funnel">
        {FUNNEL.map((step) => (
          <li key={step} className="bg-base-100 px-4 py-3">
            <p className="nums text-2xl font-semibold">{campaign.funnel[step]}</p>
            <p className="text-sm text-base-content/65">{FUNNEL_LABEL[step]}</p>
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
    { keepPrevious: true },
  );
  const now = new Date();
  const items = loaded.data?.items ?? [];

  return (
    <section className="mt-8" aria-labelledby="people">
      <h2 id="people" className="text-lg font-semibold">
        People
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-box bg-base-200 px-3 py-3">
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
        <span className="nums text-sm text-base-content/65">{loaded.data === undefined ? "" : `${loaded.data.total} ${loaded.data.total === 1 ? "person" : "people"}`}</span>
      </div>

      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the people" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <div className="skeleton mt-4 h-64 w-full" />
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-box border border-base-300 px-5 py-6" data-testid="people-empty">
          <p className="font-medium">{stage === null ? "Nobody found yet." : `Nobody at the stage ${stageWords(stage).toLowerCase()}.`}</p>
          <p className="mt-1 text-base-content/65">
            {stage === null ? "People appear here as the campaign finds them." : "Choose another stage, or every stage."}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-box border border-base-300">
            <table className="table table-sm text-sm" data-testid="people-table">
              <thead>
                <tr className="text-base-content/65">
                  <th className="font-medium">Person</th>
                  <th className="font-medium">Company</th>
                  <th className="font-medium">Stage</th>
                  <th className="font-medium">Score</th>
                  <th className="min-w-[16rem] font-medium">Why the AI scored them so</th>
                  <th className="font-medium">Next action</th>
                  <th>
                    <span className="sr-only">LinkedIn profile</span>
                  </th>
                </tr>
              </thead>
              <tbody>
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
                      <tr>
                        <td colSpan={7} className="bg-base-200/60 px-4 py-4">
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
    <tr data-testid="prospect-row" className={props.open ? "bg-base-200/60" : ""}>
      <td className="min-w-[12rem] py-3">
        <button type="button" className="text-left font-semibold hover:underline" aria-expanded={props.open} onClick={props.onToggle}>
          {p.person.fullName}
        </button>
        {p.person.headline !== null && <p className="text-base-content/75">{p.person.headline}</p>}
        {p.person.doNotContact && <span className="badge badge-sm mt-1 border-0 bg-error/15 text-error">Do not contact</span>}
      </td>
      <td>{p.person.company ?? <span className="text-base-content/45">Unknown</span>}</td>
      <td className="whitespace-nowrap" data-testid="prospect-stage">
        {stageWords(p.stage)}
        {stopped}
      </td>
      <td>
        <span
          className={`nums inline-flex size-7 items-center justify-center rounded-field font-semibold ${SCORE_CHIP[scoreTone(p.score)]}`}
          aria-label={p.score === null ? "Not scored" : `Score ${formatScore(p.score)} of 10`}
        >
          {p.score === null ? "–" : formatScore(p.score)}
        </span>
      </td>
      <td className="text-base-content/85">{p.scoreReason ?? <span className="text-base-content/45">Not scored yet</span>}</td>
      <td className="min-w-[9rem]">
        {p.nextActionAt === null ? (
          <span className="text-base-content/45">Nothing planned</span>
        ) : (
          <>
            {next !== undefined && <p>{next}</p>}
            <p className="text-base-content/65">{formatNext(p.nextActionAt, timeZone, now)}</p>
          </>
        )}
      </td>
      <td>
        <a href={p.person.profileUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 whitespace-nowrap text-base-content/75 link-hover">
          Profile
          <IconExternal />
          <span className="sr-only">of {p.person.fullName} on LinkedIn (opens in your browser)</span>
        </a>
      </td>
    </tr>
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
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,1fr)_17rem]" data-testid="prospect-detail">
      <div className="min-w-0">
        <h3 className="font-semibold">Texts as sent</h3>
        <dl className="mt-2 flex flex-col gap-3">
          {texts.map(([label, text, none]) => (
            <div key={label}>
              <dt className="text-xs text-base-content/55">{label}</dt>
              <dd className={`whitespace-pre-line ${text === null ? "text-base-content/55" : "border-l-2 border-base-300 pl-3"}`}>{text ?? none}</dd>
            </div>
          ))}
        </dl>
        {p.reviewReason !== null && <p className="mt-3 rounded-field bg-accent/20 px-3 py-2">Held for review: {p.reviewReason.replace(/_/g, " ")}</p>}
      </div>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-semibold">History</h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {history(p).map((e) => (
              <li key={e.label} className="grid grid-cols-[6.5rem_1fr] gap-2">
                <span className="nums text-base-content/60">{formatStamp(e.at, timeZone)}</span>
                <span>{e.label}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-box border border-base-300 bg-base-100 px-3 py-3">
          <SwitchRow
            id={switchId}
            label="Do not contact"
            tone="warning"
            checked={doNotContact}
            disabled={busy}
            onChange={change}
            hint="The app never invites or messages this person, in any campaign."
          />
          {error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ messages and timings

const POLICY_WORDS = { calendar: "every day counts", working_days: "only working days count" } as const;

function MessagesAndTimings({ campaign, onSaved }: { readonly campaign: Campaign; readonly onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = LIVE.has(campaign.status);

  return (
    <section className="mt-10" aria-labelledby="messages-timings">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="messages-timings" className="text-lg font-semibold">
          Messages and timings
        </h2>
        {live && !editing && (
          <button
            type="button"
            className="btn btn-sm border-base-300 bg-base-100"
            onClick={() => {
              setNotice(undefined);
              setEditing(true);
            }}
          >
            Edit messages and timings
          </button>
        )}
      </div>
      {notice !== undefined && (
        <p role="status" className="mt-3 text-sm text-primary">
          {notice}
        </p>
      )}
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
        <div className="mt-3 rounded-box border border-base-300 px-4 py-4">
          {!live && (
            <p className="mb-3 text-sm text-base-content/65">
              {campaign.status === "draft" ? "A draft is changed in its setup steps." : `A${campaign.status === "archived" ? "n archived" : " finished"} campaign cannot be changed.`}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-base-content/65">Invite note</dt>
            <dd className="whitespace-pre-line">{campaign.inviteNote === null || campaign.inviteNote === "" ? <span className="text-base-content/55">No note</span> : campaign.inviteNote}</dd>
            <dt className="text-base-content/65">First message</dt>
            <dd className="whitespace-pre-line">{campaign.firstMessage === "" ? <span className="text-base-content/55">Not written</span> : campaign.firstMessage}</dd>
            <dt className="text-base-content/65">Follow-up</dt>
            <dd className="whitespace-pre-line" data-testid="current-follow-up">
              {campaign.followUp === "" ? <span className="text-base-content/55">No follow-up</span> : campaign.followUp}
            </dd>
            <dt className="text-base-content/65">AI-written line</dt>
            <dd>{campaign.aiPersonalise ? "On" : "Off"}</dd>
            <dt className="text-base-content/65">Waits</dt>
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
    <div className="mt-3 rounded-box border border-base-300 px-4 py-5" data-testid="live-edit">
      <p className="mb-5 rounded-field bg-accent/20 px-3 py-2">Edits apply only to steps not yet sent. Texts already sent stay as they were.</p>
      <MessageFields campaignId={campaign.id} form={form} set={set} errors={errors} />
      <h3 className="mt-8 mb-4 font-semibold">Timings</h3>
      <TimingFields form={form} set={set} errors={errors} />
      {error !== undefined && (
        <p role="alert" className="mt-5 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save changes
        </button>
        <button type="button" className="btn btn-sm btn-ghost border-base-300" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
