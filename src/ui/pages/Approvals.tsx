import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { approveAll, approveProspect, listApprovals, rejectProspect, toApiError } from "../api";
import type { ApprovalItem, Evidence, Person, PreviewText } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatScore, plural } from "../format";
import { ActionError, CampaignSelect, EmptyState, LoadError, Notice, ScoreChip, SECONDARY_BUTTON, TOOLBAR } from "../formParts";
import { IconCheck, IconExternal, IconX } from "../icons";
import { useLoad } from "../useLoad";
import { PageHeader } from "./PageHeader";

const SCORE_STEPS = [0, 5, 6, 7, 8] as const;
const COLUMNS = "lg:grid-cols-[3.25rem_minmax(12rem,1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_8.75rem]";

type Decision = "approve" | "reject";

/** The approval queue: one row per prospect waiting, decided with the buttons or the A and R keys. */
export function Approvals() {
  const { home, refresh } = useAppData();
  const [minScore, setMinScore] = useState<number>(0);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const loaded = useLoad(
    () => listApprovals({ campaignId, minScore: minScore === 0 ? null : minScore, pageSize: 200 }),
    `${campaignId ?? "all"}|${minScore}`,
  );
  /** Rows decided (or being decided) on this visit: they leave the list at once. */
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const [decided, setDecided] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /** The ids on screen when "Approve all" was pressed: exactly what the dialog approves. */
  const [confirmIds, setConfirmIds] = useState<readonly number[] | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [allError, setAllError] = useState<string | undefined>(undefined);
  /** Single decisions sent and not answered yet. */
  const [deciding, setDeciding] = useState(0);
  const rows = useRef(new Map<number, HTMLDivElement>());

  // New people: Home's count of prospects waiting rises as the engine scores them. The list is
  // loaded again when that count moves away from the one it is in step with, but never in the
  // middle of a decision (a dialog open or a request on its way): then a line says who is waiting.
  const waiting = home?.needsYou.pendingApproval;
  const busy = confirmIds !== null || approvingAll || deciding > 0;
  /** Home's count the list on screen matches, less the decisions made here since. */
  const [inStep, setInStep] = useState(waiting);
  const [reloads, setReloads] = useState(0);
  if (waiting !== undefined && waiting !== inStep && (inStep === undefined || !busy)) {
    setInStep(waiting);
    // The first count to arrive is the one the list was loaded with.
    if (inStep !== undefined) setReloads((n) => n + 1);
  }
  const arrived = busy && waiting !== undefined && inStep !== undefined ? waiting - inStep : 0;
  /** The row that had the focus when the list was asked for again, to give it back. */
  const focusedBefore = useRef<number | undefined>(undefined);
  const { reload } = loaded;
  useEffect(() => {
    if (reloads === 0) return;
    focusedBefore.current = [...rows.current].find(([, element]) => element.contains(document.activeElement))?.[0];
    reload();
  }, [reloads, reload]);
  useEffect(() => {
    const id = focusedBefore.current;
    focusedBefore.current = undefined;
    const element = id === undefined ? undefined : rows.current.get(id);
    if (element !== undefined && !element.contains(document.activeElement)) element.focus();
  }, [loaded.data]);

  const all = loaded.data?.items ?? [];
  const items = all.filter((item) => !gone.has(item.id));
  const shownCount = items.length;
  /** Everyone waiting under these filters, when there are more than one page shows. */
  const matching = loaded.data === undefined ? 0 : loaded.data.total - (all.length - items.length);
  const campaigns = (home?.campaigns ?? []).filter((c) => c.status !== "archived");
  const campaignName = campaigns.find((c) => c.id === campaignId)?.name;

  const without = (id: number) => (set: ReadonlySet<number>) => new Set([...set].filter((x) => x !== id));
  const withoutError = (id: number) => (map: ReadonlyMap<number, string>) => new Map([...map].filter(([x]) => x !== id));

  const focusRow = (id: number | undefined) => {
    if (id !== undefined) rows.current.get(id)?.focus();
  };

  const decide = (item: ApprovalItem, decision: Decision) => {
    const index = items.findIndex((i) => i.id === item.id);
    focusRow((items[index + 1] ?? items[index - 1])?.id);
    setGone((set) => new Set(set).add(item.id));
    setRowErrors(withoutError(item.id));
    setNotice(undefined);
    setDeciding((n) => n + 1);
    (decision === "approve" ? approveProspect(item.id) : rejectProspect(item.id))
      .then(() => {
        setDecided((n) => n + 1);
        // Home's count drops by this one; that is not news.
        setInStep((n) => (n === undefined ? n : n - 1));
        refresh();
      })
      .catch((failure: unknown) => {
        const error = toApiError(failure);
        if (error.status === 409 || error.status === 404) {
          // Decided somewhere else meanwhile: it stays out of the queue.
          setNotice(`${item.person.fullName} was already decided: ${error.message}`);
          refresh();
          return;
        }
        setGone(without(item.id));
        setRowErrors((map) => new Map(map).set(item.id, `Could not ${decision} ${item.person.fullName}: ${error.message}`));
      })
      .finally(() => setDeciding((n) => n - 1));
  };

  const onRowKey = (item: ApprovalItem) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select") !== null) return;
    const index = items.findIndex((i) => i.id === item.id);
    switch (event.key.toLowerCase()) {
      case "a":
        event.preventDefault();
        decide(item, "approve");
        break;
      case "r":
        event.preventDefault();
        decide(item, "reject");
        break;
      case "arrowdown":
      case "j":
        event.preventDefault();
        focusRow(items[index + 1]?.id);
        break;
      case "arrowup":
      case "k":
        event.preventDefault();
        focusRow(items[index - 1]?.id);
        break;
      default:
    }
  };

  const runApproveAll = (ids: readonly number[]) => {
    setApprovingAll(true);
    setAllError(undefined);
    approveAll(ids)
      .then(({ approved, skipped }) => {
        setGone((set) => new Set([...set, ...ids]));
        setDecided((n) => n + approved);
        setInStep((n) => (n === undefined ? n : n - approved));
        setNotice(`${approved} approved${skipped === 0 ? "" : `, ${skipped} no longer waiting`}.`);
        setConfirmIds(null);
      })
      .catch((failure: unknown) => setAllError(`Could not approve them all: ${toApiError(failure).message}`))
      .finally(() => {
        setApprovingAll(false);
        loaded.reload();
        refresh();
      });
  };

  const filtered = minScore > 0 || campaignId !== null;

  return (
    <>
      <PageHeader title="Approval queue" aside={waiting === undefined ? undefined : `${waiting} waiting, ${decided} decided`} />

      <div className="flex flex-col gap-group">
      <div className={TOOLBAR}>
        <span className="text-sm" id="min-score-label">
          Minimum score
        </span>
        <div className="join" role="group" aria-labelledby="min-score-label">
          {SCORE_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              aria-pressed={minScore === step}
              className={`${minScore === step ? "btn btn-neutral" : SECONDARY_BUTTON} join-item btn-sm nums`}
              onClick={() => setMinScore(step)}
            >
              {step === 0 ? "Any" : `${step}+`}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only sm:not-sr-only">Campaign</span>
          <CampaignSelect campaigns={campaigns} value={campaignId} onChange={setCampaignId} />
        </label>
        <span className="nums text-sm text-muted" data-testid="showing">
          Showing {shownCount}
          {matching > shownCount ? ` of ${matching}` : ""}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary w-full sm:ml-auto sm:w-auto"
          disabled={shownCount === 0 || loaded.status !== "ok"}
          onClick={() => {
            setAllError(undefined);
            setConfirmIds(items.map((item) => item.id));
          }}
        >
          <IconCheck />
          Approve all {shownCount} shown
        </button>
      </div>

      <p className="hidden text-sm text-muted lg:block">
        Click a row, then press <kbd className="kbd kbd-xs">A</kbd> to approve or <kbd className="kbd kbd-xs">R</kbd> to reject. The next row
        is selected for you; <kbd className="kbd kbd-xs">↑</kbd> <kbd className="kbd kbd-xs">↓</kbd> move between rows.
      </p>

      {notice !== undefined && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}

      {loaded.status === "error" ? (
        <LoadError what="the approval queue" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.status === "loading" ? (
        <div className="flex flex-col gap-3" aria-label="Loading">
          {[0, 1, 2].map((n) => (
            <div key={n} className="skeleton h-24 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            testId="queue-empty"
            title={`No prospects waiting${minScore > 0 ? ` with a score of ${minScore} or more` : ""}${campaignName === undefined ? "" : ` in ${campaignName}`}.`}
            action={
              <button
                type="button"
                className={`${SECONDARY_BUTTON} btn-sm`}
                onClick={() => {
                  setMinScore(0);
                  setCampaignId(null);
                }}
              >
                Show everyone waiting
              </button>
            }
          />
        ) : (
          <EmptyState testId="queue-empty" title="The approval queue is empty.">
            When a campaign finds and scores new people, they wait here for you. Nobody is invited before you approve them.
          </EmptyState>
        )
      ) : (
        <div className="rounded-box border border-base-300" role="table" aria-label="Prospects waiting for approval">
          <div role="rowgroup" className="hidden lg:block">
            <div role="row" className={`grid gap-4 border-b border-base-300 px-4 py-2 text-sm text-muted ${COLUMNS}`}>
              <span role="columnheader">Score</span>
              <span role="columnheader">Person</span>
              <span role="columnheader">Why the AI picked them</span>
              <span role="columnheader">What they will receive</span>
              <span role="columnheader" className="text-right">
                Decide
              </span>
            </div>
          </div>
          <div role="rowgroup">
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                showCampaign={campaignId === null}
                error={rowErrors.get(item.id)}
                onDecide={(decision) => decide(item, decision)}
                onKeyDown={onRowKey(item)}
                register={(element) => {
                  if (element === null) rows.current.delete(item.id);
                  else rows.current.set(item.id, element);
                }}
              />
            ))}
          </div>
        </div>
      )}
      </div>

      <ConfirmDialog
        open={confirmIds !== null}
        title={`Approve all ${plural(confirmIds?.length ?? 0, "prospect", "prospects")} shown?`}
        confirmLabel={`Approve ${confirmIds?.length ?? 0}`}
        busy={approvingAll}
        error={allError}
        onConfirm={() => {
          if (confirmIds !== null) runApproveAll(confirmIds);
        }}
        onCancel={() => setConfirmIds(null)}
      >
        <p>
          {plural(confirmIds?.length ?? 0, "prospect", "prospects")}
          {minScore > 0 ? ` with a score of ${minScore} or more` : ""}
          {campaignName === undefined ? "" : ` in ${campaignName}`} will be invited.
        </p>
        <p className="text-base-content">The app sends the invites itself, within your working hours and daily limits.</p>
        {arrived > 0 && (
          <p role="status" className="text-sm" data-testid="new-arrivals">
            {arrived === 1 ? "1 new person is" : `${arrived} new people are`} waiting —{" "}
            <button type="button" className="link" disabled={approvingAll} onClick={() => setConfirmIds(null)}>
              refresh
            </button>
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function Row({
  item,
  showCampaign,
  error,
  onDecide,
  onKeyDown,
  register,
}: {
  readonly item: ApprovalItem;
  readonly showCampaign: boolean;
  readonly error: string | undefined;
  readonly onDecide: (decision: Decision) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly register: (element: HTMLDivElement | null) => void;
}) {
  const { person } = item;
  const place = [person.company, person.location].filter((part): part is string => part !== null && part !== "").join(", ");
  return (
    <div
      ref={register}
      role="row"
      tabIndex={0}
      aria-label={`${person.fullName}${item.score === null ? "" : `, score ${formatScore(item.score)}`}`}
      onKeyDown={onKeyDown}
      data-testid="approval-row"
      className={`grid grid-cols-[2.75rem_1fr] gap-x-3 gap-y-2.5 border-b border-base-300 px-4 py-3 outline-none last:border-b-0 focus-within:bg-base-200/60 focus-within:ring-2 focus-within:ring-neutral focus-within:ring-inset lg:gap-x-4 ${COLUMNS}`}
    >
      <ScoreChip score={item.score} size="lg" role="cell" />
      <div role="cell" className="min-w-0">
        <p className="font-semibold">{person.fullName}</p>
        {person.headline !== null && <p className="text-sm">{person.headline}</p>}
        {place !== "" && <p className="text-sm text-muted">{place}</p>}
        {showCampaign && <p className="text-sm text-muted">For {item.campaignName}</p>}
        <a
          href={person.profileUrl}
          target="_blank"
          rel="noreferrer"
          className="link mt-1 inline-flex items-center gap-1 text-sm text-base-content link-hover"
        >
          LinkedIn profile
          <IconExternal />
          <span className="sr-only">(opens in your browser)</span>
        </a>
      </div>
      <div role="cell" className="col-span-2 flex flex-col gap-1.5 text-sm lg:col-span-1">
        <p>{item.scoreReason ?? "The AI gave no reason."}</p>
        <EvidenceLines industry={person.industryEvidence} size={person.sizeEvidence} aiLine={item.aiLineEvidence ?? null} />
      </div>
      <div role="cell" className="col-span-2 flex flex-col gap-2 border-l-2 border-base-300 pl-3 text-sm text-base-content lg:col-span-1">
        {item.preview.inviteNote !== null && <Text label="Invite note" text={item.preview.inviteNote} person={person} />}
        <Text label="First message, after they accept" text={item.preview.firstMessage} person={person} />
        <FollowUp text={item.followUpPreview} person={person} />
      </div>
      <div role="cell" className="col-span-2 flex items-start gap-2 lg:col-span-1 lg:flex-col lg:items-stretch">
        <button type="button" className="btn btn-sm btn-outline flex-1 border-primary/50 text-primary lg:flex-none" onClick={() => onDecide("approve")}>
          <IconCheck />
          Approve
          <kbd className="kbd kbd-xs hidden lg:inline-flex" aria-hidden="true">
            A
          </kbd>
        </button>
        <button type="button" className={`${SECONDARY_BUTTON} btn-sm flex-1 lg:flex-none`} onClick={() => onDecide("reject")}>
          <IconX />
          Reject
          <kbd className="kbd kbd-xs hidden lg:inline-flex" aria-hidden="true">
            R
          </kbd>
        </button>
      </div>
      <ActionError message={error} className="col-span-2 lg:col-span-5" />
    </div>
  );
}

/** The person's own values that a text's variables are filled from (the AI line is not sent with the queue). */
function filledValues(person: Person): readonly string[] {
  const values = [person.firstName, person.company, person.title, person.location, person.industryEvidence?.value ?? null];
  return [...new Set(values.flatMap((v) => (v === null || v.trim().length < 2 ? [] : [v.trim()])))].sort((a, b) => b.length - a.length);
}

/** A text as it will be sent, with the values filled in for this person at 500, so the fixed words and the personal ones read apart. */
function Filled({ text, person }: { readonly text: string; readonly person: Person }) {
  const values = filledValues(person);
  if (values.length === 0) return <>{text}</>;
  const escaped = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "g");
  const parts: ReactNode[] = text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="font-medium">
        {part}
      </span>
    ) : (
      part
    ),
  );
  return <>{parts}</>;
}

function Text({ label, text, person }: { readonly label: string; readonly text: PreviewText; readonly person: Person }) {
  return (
    <div>
      <p className="text-caption text-muted">{label}</p>
      {text.ok ? (
        <p className="whitespace-pre-line">
          <Filled text={text.text} person={person} />
        </p>
      ) : (
        <Notice tone="waits" className="text-base-content">
          Cannot be written for this person yet: {text.message}
        </Notice>
      )}
    </div>
  );
}

const FOLLOW_UP_LABEL = "Follow-up, if they do not reply";

/** The follow-up, folded away to keep the row short; open at once when it cannot be written. */
function FollowUp({ text, person }: { readonly text: PreviewText | null; readonly person: Person }) {
  if (text === null) {
    return (
      <div>
        <p className="text-caption text-muted">Follow-up</p>
        <p className="text-muted">No follow-up</p>
      </div>
    );
  }
  if (!text.ok) return <Text label={FOLLOW_UP_LABEL} text={text} person={person} />;
  return (
    <details data-testid="follow-up">
      <summary className="cursor-pointer text-caption text-muted hover:text-base-content">{FOLLOW_UP_LABEL}</summary>
      <p className="mt-0.5 whitespace-pre-line">
        <Filled text={text.text} person={person} />
      </p>
    </details>
  );
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  profile: "on the profile",
  card: "on the search card",
  "company page": "on the company page",
};

function EvidenceLines({ industry, size, aiLine }: { readonly industry: Evidence; readonly size: Evidence; readonly aiLine: string | null }) {
  const seen = (evidence: NonNullable<Evidence>) => `${evidence.value}, seen ${SOURCE_WORDS[evidence.source] ?? `in ${evidence.source}`}.`;
  if (industry === null && size === null && aiLine === null) return null;
  return (
    <div className="text-muted">
      {industry !== null && <p>Industry: {seen(industry)}</p>}
      {size !== null && <p>Size: {seen(size)}</p>}
      {aiLine !== null && <p>Personal line based on: &ldquo;{aiLine}&rdquo;</p>}
    </div>
  );
}
