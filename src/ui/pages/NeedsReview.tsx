import { useEffect, useId, useRef, useState } from "react";
import { listActivity, listReview, resolveReview, toApiError } from "../api";
import type { ResolveStage, ReviewItem } from "../apiSchemas";
import { useAppData } from "../appData";
import { asSentence, formatScore, formatWhen, plural } from "../format";
import { ActionError, Announce, EmptyState, LoadError, Notice, SECONDARY_BUTTON, SkeletonRows } from "../formParts";
import { IconExternal } from "../icons";
import { useLoad } from "../useLoad";
import { PageHeader } from "./PageHeader";

/** The choices in two groups: carry on from a step of the sequence (in its order), or take them out. */
const CHOICE_GROUPS: readonly { readonly caption: string; readonly stages: readonly ResolveStage[] }[] = [
  { caption: "Carry on from where they are", stages: ["approved", "invited", "accepted", "message_sent"] },
  { caption: "Take them out", stages: ["stopped", "rejected"] },
];

/** The choice that matches the "So far" line: the step the person has reached. Null when none of them does. */
function reachedStage(item: ReviewItem): ResolveStage | null {
  if (item.followUpSentAt !== null) return null;
  if (item.firstMessageSentAt !== null) return "message_sent";
  if (item.acceptanceObservedAt !== null) return "accepted";
  if (item.invitedAt !== null) return "invited";
  if (item.approvedAt !== null) return "approved";
  return null;
}

/** Every choice, in plain words. Nothing is chosen until the user picks one: the app never decides for them. */
const CHOICE_LABEL: Readonly<Record<ResolveStage, string>> = {
  approved: "Approve: the invite will be sent",
  invited: "Invited: wait for them to accept",
  accepted: "Accepted: send the first message next",
  message_sent: "First message sent: send the follow-up next",
  stopped: "Stop the sequence: nothing more is sent",
  rejected: "Reject: take them out of this campaign",
};
const CHOICE_DONE: Readonly<Record<ResolveStage, string>> = {
  approved: "continues: the invite is sent next",
  invited: "continues: the app waits for them to accept",
  accepted: "continues: the first message is sent next",
  message_sent: "continues: the follow-up is sent next",
  stopped: "stopped. Nothing more is sent to them",
  rejected: "rejected. They leave this campaign",
};

function progress(item: ReviewItem, timeZone: string, now: Date): string {
  const when = (iso: string) => formatWhen(iso, timeZone, now);
  if (item.followUpSentAt !== null) return `Follow-up sent ${when(item.followUpSentAt)}.`;
  if (item.firstMessageSentAt !== null) return `First message sent ${when(item.firstMessageSentAt)}; no follow-up yet.`;
  if (item.acceptanceObservedAt !== null) return `Accepted the invite ${when(item.acceptanceObservedAt)}; no message sent yet.`;
  if (item.invitedAt !== null) return `Invited ${when(item.invitedAt)}; not accepted yet.`;
  if (item.approvedAt !== null) return `Approved ${when(item.approvedAt)}; not invited yet.`;
  return `Found ${when(item.foundAt)}; not contacted.`;
}

/**
 * What one hold looks like in the item's own data: the reason and the progress it was held at. A
 * resolve changes these (the stage's time is set, the reason cleared), so a later hold differs.
 */
function holdOf(item: ReviewItem): string {
  return JSON.stringify([
    item.reviewReason,
    item.approvedAt,
    item.invitedAt,
    item.acceptanceObservedAt,
    item.firstMessageSentAt,
    item.followUpSentAt,
    item.nextActionAt,
    item.screenshotUrl,
  ]);
}

/** Needs review: people the app would not decide on by itself, each with the reason and what the user can do. */
export function NeedsReview() {
  const { home, refresh } = useAppData();
  const count = home?.needsYou.needsReview;
  const key = `review-${count ?? "?"}`;
  const loaded = useLoad(() => listReview({ pageSize: 100 }), key, { keepPrevious: true });
  // When each person was held: the activity log's warning line about them (the API has no such field).
  const held = useLoad(() => listActivity({ level: "warning", pageSize: 200 }), key, { keepPrevious: true });
  /**
   * People resolved on this visit, each with the hold they were resolved from. They stay hidden while
   * an answer still lists that same hold (it was asked for before the resolve), and come back when a
   * fresh answer lists them with another hold, held again by a later step.
   */
  const [gone, setGone] = useState<ReadonlyMap<number, string>>(new Map());
  const [checkedFor, setCheckedFor] = useState(loaded.data);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  if (loaded.data !== checkedFor) {
    setCheckedFor(loaded.data);
    if (loaded.data !== undefined && gone.size > 0) {
      const listed = new Map(loaded.data.items.map((item) => [item.id, holdOf(item)] as const));
      // Not listed any more: the resolve has landed, so a later listing is a new hold.
      const still = new Map([...gone].filter(([id, hold]) => listed.get(id) === hold));
      if (still.size !== gone.size) setGone(still);
    }
  }

  const heldAt = new Map<number, string>();
  for (const line of held.data?.items ?? []) {
    if (line.prospectId !== null && line.message.includes("needs review") && !heldAt.has(line.prospectId)) heldAt.set(line.prospectId, line.at);
  }
  const items = (loaded.data?.items ?? []).filter((item) => gone.get(item.id) !== holdOf(item));

  return (
    <>
      <PageHeader
        title="Needs review"
        aside={loaded.data === undefined ? undefined : `${plural(items.length, "person", "people")} held`}
        lead="The app stopped short with these people rather than guess. Nothing more happens to them until you choose."
      />
      <Announce>{notice !== undefined && <p className="mb-group text-sm text-primary">{notice}</p>}</Announce>
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the people held for review" message={loaded.error.message} onRetry={loaded.reload} />
      ) : loaded.data === undefined ? (
        <SkeletonRows rows={2} rowClassName="h-96" />
      ) : items.length === 0 ? (
        <EmptyState title="Nobody is held for review." testId="review-empty">
          When the app is unsure what happened with a person, it holds them here instead of guessing.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-base-300 rounded-box border border-base-300">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              heldAt={heldAt.get(item.id)}
              onResolved={(stage) => {
                setGone((map) => new Map(map).set(item.id, holdOf(item)));
                setNotice(`${item.person.fullName} ${CHOICE_DONE[stage]}.`);
                refresh();
                // A fresh answer, asked for after the resolve, no longer lists them and so lets a later hold show.
                loaded.reload();
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function ReviewCard({ item, heldAt, onResolved }: { readonly item: ReviewItem; readonly heldAt: string | undefined; readonly onResolved: (stage: ResolveStage) => void }) {
  const { timeZone } = useAppData();
  const [choice, setChoice] = useState<ResolveStage | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const noteId = useId();
  const choiceName = useId();
  const now = new Date();
  const { person } = item;
  const reached = reachedStage(item);

  const resolve = (to: ResolveStage) => {
    setBusy(true);
    setError(undefined);
    resolveReview(item.id, { stage: to, note: note.trim() === "" ? null : note.trim() })
      .then(() => onResolved(to))
      .catch((failure: unknown) => {
        const apiError = toApiError(failure);
        setError(apiError.fields["note"] ?? apiError.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <li className="grid gap-x-section gap-y-block p-card lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="review-item" aria-label={person.fullName}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">{person.fullName}</h2>
          <a href={person.profileUrl} target="_blank" rel="noreferrer" className="link inline-flex min-h-6 items-center gap-1 text-sm text-base-content link-hover max-lg:-my-2.5 max-lg:min-h-11">
            LinkedIn profile
            <IconExternal />
            <span className="sr-only">(opens in your browser)</span>
          </a>
        </div>
        {person.headline !== null && <p className="text-sm">{person.headline}</p>}
        <p className="text-sm text-muted">
          In {item.campaignName}
          {heldAt === undefined ? "" : `, held ${formatWhen(heldAt, timeZone, now)}`}.
        </p>
        <Notice tone="waits" className="mt-group">
          <span className="font-medium">Why: </span>
          {item.reviewReason === null ? "The app did not record a reason." : asSentence(item.reviewReason)}
        </Notice>
        <p className="mt-group text-sm" data-testid="review-score">
          {item.score === null ? (
            <span className="text-base-content">Not scored</span>
          ) : (
            <>
              <span className="nums font-medium">Score {formatScore(item.score)} of 10</span>
              {item.scoreReason !== null && <span className="text-base-content">: {item.scoreReason}</span>}
            </>
          )}
        </p>
        <p className="mt-1 text-sm text-base-content">So far: {progress(item, timeZone, now)}</p>
        {item.screenshotUrl !== null && <Screenshot url={item.screenshotUrl} name={person.fullName} />}
      </div>

      <div className="flex flex-col gap-4">
        <fieldset className="text-sm">
          <legend className="mb-2 font-medium">What should happen next</legend>
          <div className="flex flex-col gap-3">
            {CHOICE_GROUPS.map((group) => (
              <div key={group.caption} role="group" aria-label={group.caption}>
                <p className="mb-1 text-caption text-muted" aria-hidden="true">
                  {group.caption}
                </p>
                <div className="flex flex-col">
                  {group.stages.map((stage) => (
                    <label key={stage} className="flex cursor-pointer items-start gap-2 py-1 max-lg:py-3">
                      <input
                        type="radio"
                        className="radio radio-sm radio-primary mt-0.5"
                        name={choiceName}
                        value={stage}
                        checked={choice === stage}
                        disabled={busy}
                        onChange={() => setChoice(stage)}
                      />
                      <span>
                        {CHOICE_LABEL[stage]}
                        {stage === reached && <span className="ml-1.5 text-muted">(where they are now)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm" htmlFor={noteId}>
          <span>
            <span className="font-medium">Note for the activity log</span> (optional)
          </span>
          <textarea
            id={noteId}
            className="textarea textarea-sm w-full bg-base-100"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="For example: checked on LinkedIn, the invite went out"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || choice === null}
            aria-busy={busy}
            onClick={() => {
              if (choice !== null) resolve(choice);
            }}
          >
            {busy && <span className="loading loading-spinner loading-xs" />}
            Confirm
          </button>
          {choice === null && <p className="text-sm text-muted">Choose what should happen first.</p>}
        </div>
        <ActionError message={error} />
      </div>
    </li>
  );
}

/** The page the app saw when it held the person: a thumbnail that opens at full size. */
function Screenshot({ url, name }: { readonly url: string; readonly name: string }) {
  const [open, setOpen] = useState(false);
  /** The app named a screenshot it could not serve (deleted, or never written). */
  const [missing, setMissing] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const alt = `The LinkedIn page the app saw when it held ${name}`;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (missing) {
    return (
      <p className="mt-group text-sm text-muted" data-testid="screenshot-missing">
        A screenshot was saved, but the app could not show it.
      </p>
    );
  }

  return (
    <figure className="mt-group">
      <button
        type="button"
        className="block overflow-hidden rounded-field border border-base-300 hover:border-base-content/40"
        onClick={() => setOpen(true)}
        aria-label={`Open the screenshot for ${name} at full size`}
      >
        <img
          src={url}
          alt={alt}
          className="h-28 w-auto max-w-full bg-base-200 object-cover object-top"
          data-testid="screenshot-thumbnail"
          onError={() => setMissing(true)}
        />
      </button>
      {/* The button's name already says this to a screen reader; the caption is for the eye. */}
      <figcaption className="mt-1 text-caption text-muted" aria-hidden="true">
        What the app saw. Open at full size.
      </figcaption>
      <dialog ref={ref} className="modal" aria-labelledby={titleId} onClose={() => setOpen(false)}>
        {/* The box stays 16px clear of the window's edges; a tall screenshot scrolls under the fixed title row. */}
        <div className="modal-box flex max-h-viewer w-11/12 max-w-6xl flex-col overflow-hidden">
          <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
            <h3 id={titleId} className="font-semibold">
              Screenshot: {name}
            </h3>
            <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            <img src={url} alt={alt} className="h-auto w-full" />
          </div>
        </div>
        {/* As in the confirm dialog: a click outside closes it; the keyboard has Escape and Close, so this is no tab stop. */}
        <form method="dialog" className="modal-backdrop">
          <button type="submit" tabIndex={-1} aria-hidden="true">
            Close
          </button>
        </form>
      </dialog>
    </figure>
  );
}
