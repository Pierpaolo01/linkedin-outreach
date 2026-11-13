import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { approveAll, approveProspect, listApprovals, listCampaigns, rejectProspect, toApiError } from "../api";
import type { ApprovalItem, Campaign, Evidence, PreviewText } from "../apiSchemas";
import { useAppData } from "../appData";
import { ConfirmDialog } from "../ConfirmDialog";
import { formatScore, plural } from "../format";
import { ActionError, Announce, CampaignSelect, Disclosure, EmptyState, FilledText, focusInView, LoadError, Notice, ScoreChip, SECONDARY_BUTTON, SkeletonRows, TOOLBAR } from "../formParts";
import { IconCheck, IconExternal, IconX } from "../icons";
import { useLoad } from "../useLoad";
import { failure, type Failure } from "../words";
import { PageHeader } from "./PageHeader";

const SCORE_STEPS = [0, 5, 6, 7, 8] as const;
/*
 * The five columns need a list box of 56rem (`--container-queue`); in a narrower box (a phone, or a laptop at
 * 1024 with the sidebar docked) each prospect is the stacked row: score and person, then the reason, the texts
 * and the buttons at full width.
 */
const COLUMNS = "@queue:grid-cols-[3.25rem_minmax(12rem,1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_8.75rem]";

type Decision = "approve" | "reject";
/** The empty state's id: it takes the focus when the last row has been decided. */
const EMPTY_ID = "queue-empty";
/** A campaign's three templates, where the texts in the queue were filled from. */
type Templates = Pick<Campaign, "inviteNote" | "firstMessage" | "followUp">;
const NO_TEMPLATES: ReadonlyMap<number, Templates> = new Map();
/** A decided row folding away, and the row it sat above when it was decided (none when it was last). */
type Leaving = { readonly item: ApprovalItem; readonly before: number | undefined };

/** The approval queue: one row per prospect waiting, decided with the buttons or the A and R keys. */
export function Approvals() {
  const { home, refresh } = useAppData();
  const [minScore, setMinScore] = useState<number>(0);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  // The campaigns' templates come with the list, so the filled-in values are set apart from the first draw. Without
  // them (a failed load) the texts show plain, never guessed.
  const loaded = useLoad(
    () =>
      Promise.all([
        listApprovals({ campaignId, minScore: minScore === 0 ? null : minScore, pageSize: 200 }),
        listCampaigns().then(
          ({ campaigns }) => new Map(campaigns.map((c) => [c.id, { inviteNote: c.inviteNote, firstMessage: c.firstMessage, followUp: c.followUp }] as const)),
          () => NO_TEMPLATES,
        ),
      ]).then(([page, templates]) => ({ ...page, templates })),
    `${campaignId ?? "all"}|${minScore}`,
  );
  const templates = loaded.data?.templates ?? NO_TEMPLATES;
  /** Rows decided (or being decided) on this visit: they leave the list at once. */
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  /**
   * Decided rows still folding away, each drawn above the row that followed it (or last): inert, and out of the
   * count, the keyboard order and the tests' rows. Kept apart from the loaded list, which may load again meanwhile.
   */
  const [leaving, setLeaving] = useState<ReadonlyMap<number, Leaving>>(new Map());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, Failure>>(new Map());
  const [decided, setDecided] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /** What a screen reader hears when a decision lands: the row leaving the list is the only other sign. */
  const [said, setSaid] = useState<string | undefined>(undefined);
  /** The ids on screen when "Approve all" was pressed: exactly what the dialog approves. */
  const [confirmIds, setConfirmIds] = useState<readonly number[] | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [allError, setAllError] = useState<Failure | undefined>(undefined);
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
  /**
   * Approve all went through: its rows and the button that opened the dialog have gone, so the focus went to the empty
   * state. When the list loads again with people who arrived meanwhile, the first of them takes it instead.
   */
  const afterApproveAll = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = focusedBefore.current;
    focusedBefore.current = undefined;
    const element = id === undefined ? undefined : rows.current.get(id);
    if (element !== undefined && !element.contains(document.activeElement)) element.focus();
    if (afterApproveAll.current) {
      afterApproveAll.current = false;
      list.current?.querySelector<HTMLElement>("[role=row][tabindex]")?.focus();
    }
  }, [loaded.data]);

  const all = loaded.data?.items ?? [];
  const items = all.filter((item) => !gone.has(item.id));
  const shownCount = items.length;
  /** Everyone waiting under these filters, when there are more than one page shows. */
  const matching = loaded.data === undefined ? 0 : loaded.data.total - (all.length - items.length);
  const campaigns = (home?.campaigns ?? []).filter((c) => c.status !== "archived");
  const campaignName = campaigns.find((c) => c.id === campaignId)?.name;

  const without = (id: number) => (set: ReadonlySet<number>) => new Set([...set].filter((x) => x !== id));
  const notLeaving = (id: number) => (map: ReadonlyMap<number, Leaving>) => new Map([...map].filter(([x]) => x !== id));
  const withoutError = (id: number) => (map: ReadonlyMap<number, Failure>) => new Map([...map].filter(([x]) => x !== id));

  const focusRow = (id: number | undefined) => {
    if (id !== undefined) rows.current.get(id)?.focus();
  };
  /** The empty state, which takes the focus when the last row is decided (the row and its buttons have left). */
  const [focusEmpty, setFocusEmpty] = useState(0);
  useEffect(() => {
    const empty = document.getElementById(EMPTY_ID);
    if (focusEmpty > 0 && empty !== null) focusInView(empty);
  }, [focusEmpty]);

  const decide = (item: ApprovalItem, decision: Decision) => {
    const index = items.findIndex((i) => i.id === item.id);
    const next = (items[index + 1] ?? items[index - 1])?.id;
    if (next === undefined) setFocusEmpty((n) => n + 1);
    else focusRow(next);
    setGone((set) => new Set(set).add(item.id));
    setLeaving((map) => new Map(map).set(item.id, { item, before: items[index + 1]?.id }));
    setRowErrors(withoutError(item.id));
    setNotice(undefined);
    setDeciding((n) => n + 1);
    (decision === "approve" ? approveProspect(item.id) : rejectProspect(item.id))
      .then(() => {
        setDecided((n) => n + 1);
        setSaid(`${decision === "approve" ? "Approved" : "Rejected"} ${item.person.fullName}.`);
        // Home's count drops by this one; that is not news.
        setInStep((n) => (n === undefined ? n : n - 1));
        refresh();
      })
      .catch((failed: unknown) => {
        const error = toApiError(failed);
        if (error.status === 409 || error.status === 404) {
          // Decided somewhere else meanwhile: it stays out of the queue.
          setNotice(`${item.person.fullName} was already decided elsewhere, so they have left the queue.`);
          refresh();
          return;
        }
        setGone(without(item.id));
        setLeaving(notLeaving(item.id));
        const press = decision === "approve" ? "Approve" : "Reject";
        setRowErrors((map) => new Map(map).set(item.id, failure(`${item.person.fullName} was not ${press.toLowerCase()}d. They are still in the queue; press ${press} again.`, error)));
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
        // Every row shown was in the dialog, so none is left: the empty state takes the focus once the dialog has closed.
        setFocusEmpty((n) => n + 1);
        afterApproveAll.current = true;
      })
      .catch((failed: unknown) =>
        setAllError(failure(`Nobody was approved. They are still in the queue; press Approve ${ids.length} again, or Cancel.`, toApiError(failed))),
      )
      .finally(() => {
        setApprovingAll(false);
        loaded.reload();
        refresh();
      });
  };

  const filtered = minScore > 0 || campaignId !== null;
  /** Until the list has loaded there is no count to show: the bar says nothing rather than "0". */
  const counted = loaded.status === "ok";
  /** Nobody waits and no filter hides anyone: the page is the empty state alone, with no filters or button to press. */
  const empty = counted && items.length === 0 && !filtered;

  // The decided row folds to nothing, so the rows below slide up instead of jumping. The focus has already moved on.
  const ghost = (item: ApprovalItem) => (
    <div
      key={`leaving-${item.id}`}
      className="grid animate-row-leave"
      inert
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setLeaving(notLeaving(item.id));
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <Row item={item} templates={templates.get(item.campaignId)} showCampaign={campaignId === null} error={undefined} leaving />
      </div>
    </div>
  );
  /** The folding rows that sat just above this row (itself possibly folding), in order. */
  const ghostsBefore = (id: number): ReactNode[] =>
    [...leaving.values()].filter((g) => g.before === id).flatMap((g) => [...ghostsBefore(g.item.id), ghost(g.item)]);
  /** Rows a folding row can be drawn above; the rest are drawn last. */
  const placed = new Set<number | undefined>([...items.map((i) => i.id), ...leaving.keys()]);

  return (
    <>
      <PageHeader title="Approval queue" aside={waiting === undefined || (waiting === 0 && decided === 0) ? undefined : `${waiting} waiting, ${decided} decided`} />

      <div className="flex flex-col gap-group">
      {!empty && (
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
              className={`${minScore === step ? "btn btn-neutral" : SECONDARY_BUTTON} join-item btn-sm nums max-lg:min-w-11`}
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
        {counted && (
          <span className="nums text-sm text-muted" data-testid="showing">
            Showing {shownCount}
            {matching > shownCount ? ` of ${matching}` : ""}
          </span>
        )}
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
          {counted ? `Approve all ${shownCount} shown` : "Approve all shown"}
        </button>
      </div>
      )}

      {/* While it loads the hint stays, so the list does not move; with nobody to decide there is nothing to press. */}
      {!(counted && items.length === 0) && (
        <p className="hidden text-sm text-muted lg:block">
          Click a row, then press <kbd className="kbd kbd-sm">A</kbd> to approve or <kbd className="kbd kbd-sm">R</kbd> to reject. The next row
          is selected for you; <kbd className="kbd kbd-sm">↑</kbd> <kbd className="kbd kbd-sm">↓</kbd> move between rows.
        </p>
      )}

      <Announce message={said}>{notice !== undefined && <p className="text-sm text-primary">{notice}</p>}</Announce>

      {loaded.status === "error" ? (
        <LoadError what="the approval queue" error={loaded.error} onRetry={loaded.reload} />
      ) : loaded.status === "loading" ? (
        <SkeletonRows rows={3} rowClassName="h-40" />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            testId="queue-empty"
            id={EMPTY_ID}
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
          <EmptyState testId="queue-empty" title="The approval queue is empty." id={EMPTY_ID}>
            When a campaign finds and scores new people, they wait here for you. Nobody is invited before you approve them.
          </EmptyState>
        )
      ) : (
        <div className="@container rounded-box border border-base-300" role="table" aria-label="Prospects waiting for approval">
          <div role="rowgroup" className="sr-only @queue:not-sr-only">
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
          <div role="rowgroup" ref={list}>
            {items.map((item) => (
              <Fragment key={item.id}>
                {ghostsBefore(item.id)}
                <Row
                  item={item}
                  templates={templates.get(item.campaignId)}
                  showCampaign={campaignId === null}
                  error={rowErrors.get(item.id)}
                  onDecide={(decision) => decide(item, decision)}
                  onKeyDown={onRowKey(item)}
                  register={(element) => {
                    if (element === null) rows.current.delete(item.id);
                    else rows.current.set(item.id, element);
                  }}
                />
              </Fragment>
            ))}
            {[...leaving.values()].filter((g) => !placed.has(g.before)).flatMap((g) => [...ghostsBefore(g.item.id), ghost(g.item)])}
          </div>
        </div>
      )}
      </div>

      <ConfirmDialog
        open={confirmIds !== null}
        title={`Approve all ${plural(confirmIds?.length ?? 0, "prospect", "prospects")} shown?`}
        confirmLabel={`Approve ${confirmIds?.length ?? 0}`}
        busyLabel="Approving…"
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
        {/* During a safety stop nothing is sent until the user resumes, so the dialog does not say it happens on its own. */}
        <p className="text-base-content" data-testid="approve-all-when">
          The app sends the invites itself{home?.safetyStop != null ? " once you resume" : ""}, within your working window and budgets.
        </p>
        {arrived > 0 && (
          <p role="status" className="text-sm" data-testid="new-arrivals">
            {arrived === 1 ? "1 new person is" : `${arrived} new people are`} waiting.{" "}
            {/* Closing the dialog brings the list up to date by itself. */}
            <button
              type="button"
              className="link inline-flex min-h-6 items-center max-lg:-my-2.5 max-lg:min-h-11"
              disabled={approvingAll}
              onClick={() => setConfirmIds(null)}
            >
              Close this to see them
            </button>
            .
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function Row({
  item,
  templates,
  showCampaign,
  error,
  onDecide,
  onKeyDown,
  register,
  leaving = false,
}: {
  readonly item: ApprovalItem;
  /** Undefined until known: the texts then show without the filled-in values set apart. */
  readonly templates: Templates | undefined;
  readonly showCampaign: boolean;
  readonly error: Failure | undefined;
  readonly onDecide?: (decision: Decision) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly register?: (element: HTMLDivElement | null) => void;
  /** A decided row folding away: a picture of the row, not a row of the table. */
  readonly leaving?: boolean;
}) {
  const { person } = item;
  const place = [person.company, person.location].filter((part): part is string => part !== null && part !== "").join(", ");
  return (
    <div
      ref={register}
      role={leaving ? undefined : "row"}
      tabIndex={leaving ? undefined : 0}
      aria-label={leaving ? undefined : `${person.fullName}${item.score === null ? "" : `, score ${formatScore(item.score)}`}`}
      onKeyDown={onKeyDown}
      data-testid={leaving ? undefined : "approval-row"}
      className={`grid grid-cols-[2.75rem_1fr] gap-x-3 gap-y-2.5 border-b border-base-300 px-4 py-3 outline-none last:border-b-0 focus-within:bg-base-200/60 focus-visible:ring-2 focus-visible:ring-neutral focus-visible:ring-inset @queue:gap-x-4 ${COLUMNS}`}
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
          className="link mt-1 inline-flex min-h-6 items-center gap-1 text-sm text-base-content link-hover max-lg:-mt-1.5 max-lg:-mb-2.5 max-lg:min-h-11"
        >
          LinkedIn profile
          <IconExternal />
          <span className="sr-only">(opens in your browser)</span>
        </a>
      </div>
      <div role="cell" className="col-span-2 flex flex-col gap-1.5 text-sm @queue:col-span-1">
        <p>{item.scoreReason ?? "The AI gave no reason."}</p>
        <EvidenceLines industry={person.industryEvidence} size={person.sizeEvidence} aiLine={item.aiLineEvidence ?? null} />
      </div>
      <div role="cell" className="col-span-2 flex flex-col gap-2 border-l-2 border-base-300 pl-3 text-sm text-base-content @queue:col-span-1">
        {item.preview.inviteNote !== null && <Text label="Invite note" text={item.preview.inviteNote} template={templates?.inviteNote} />}
        <Text label="First message, after they accept" text={item.preview.firstMessage} template={templates?.firstMessage} />
        <FollowUp text={item.followUpPreview} template={templates?.followUp} />
      </div>
      <div role="cell" className="col-span-2 flex items-start gap-2 @queue:col-span-1 @queue:flex-col @queue:items-stretch">
        <button type="button" className="btn btn-sm flex-1 border-primary/50 bg-base-100 text-primary hover:not-disabled:bg-base-200 @queue:flex-none" onClick={() => onDecide?.("approve")}>
          <IconCheck />
          Approve
          <kbd className="kbd kbd-sm hidden lg:inline-flex" aria-hidden="true">
            A
          </kbd>
        </button>
        <button type="button" className={`${SECONDARY_BUTTON} btn-sm flex-1 @queue:flex-none`} onClick={() => onDecide?.("reject")}>
          <IconX />
          Reject
          <kbd className="kbd kbd-sm hidden lg:inline-flex" aria-hidden="true">
            R
          </kbd>
        </button>
      </div>
      <ActionError message={error} className="col-span-2 @queue:col-span-5" />
    </div>
  );
}

function Text({ label, text, template }: { readonly label: string; readonly text: PreviewText; readonly template: string | null | undefined }) {
  return (
    <div>
      <p className="text-caption text-muted">{label}</p>
      {text.ok ? (
        <p className="whitespace-pre-line" data-testid="sent-text">
          <FilledText text={text.text} template={template} />
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
function FollowUp({ text, template }: { readonly text: PreviewText | null; readonly template: string | undefined }) {
  if (text === null) {
    return (
      <div>
        <p className="text-caption text-muted">Follow-up</p>
        <p className="text-muted">No follow-up</p>
      </div>
    );
  }
  if (!text.ok) return <Text label={FOLLOW_UP_LABEL} text={text} template={template} />;
  return (
    <Disclosure
      testId="follow-up"
      summary={FOLLOW_UP_LABEL}
      summaryClassName="-my-2 py-2 text-caption text-muted hover:text-base-content max-lg:-my-3.25 max-lg:py-3.25"
    >
      <p className="mt-0.5 whitespace-pre-line" data-testid="sent-text">
        <FilledText text={text.text} template={template} />
      </p>
    </Disclosure>
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
