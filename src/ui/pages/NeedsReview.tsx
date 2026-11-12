import { useEffect, useId, useRef, useState } from "react";
import { listActivity, listReview, resolveReview, toApiError } from "../api";
import { RESOLVE_STAGES, type ResolveStage, type ReviewItem } from "../apiSchemas";
import { useAppData } from "../appData";
import { asSentence, formatScore, formatWhen, plural } from "../format";
import { IconExternal } from "../icons";
import { useLoad } from "../useLoad";
import { PageHeader } from "./PageHeader";

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

/** Needs review: people the app would not decide on by itself, each with the reason and what the user can do. */
export function NeedsReview() {
  const { home, refresh } = useAppData();
  const count = home?.needsYou.needsReview;
  const key = `review-${count ?? "?"}`;
  const loaded = useLoad(() => listReview({ pageSize: 100 }), key, { keepPrevious: true });
  // When each person was held: the activity log's warning line about them (the API has no such field).
  const held = useLoad(() => listActivity({ level: "warning", pageSize: 200 }), key, { keepPrevious: true });
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const heldAt = new Map<number, string>();
  for (const line of held.data?.items ?? []) {
    if (line.prospectId !== null && line.message.includes("needs review") && !heldAt.has(line.prospectId)) heldAt.set(line.prospectId, line.at);
  }
  const items = (loaded.data?.items ?? []).filter((item) => !gone.has(item.id));

  return (
    <>
      <PageHeader title="Needs review" aside={loaded.data === undefined ? undefined : `${plural(items.length, "person", "people")} held`} />
      <p className="mt-2 max-w-2xl text-base-content/75">
        The app stopped short with these people rather than guess. Nothing more happens to them until you choose.
      </p>
      {notice !== undefined && (
        <p role="status" className="mt-3 text-sm text-primary">
          {notice}
        </p>
      )}
      {loaded.status === "error" && loaded.data === undefined ? (
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-3 rounded-box border border-error/40 bg-error/5 px-4 py-4">
          <p className="text-error">Could not load the people held for review: {loaded.error.message}</p>
          <button type="button" className="btn btn-sm" onClick={loaded.reload}>
            Try again
          </button>
        </div>
      ) : loaded.data === undefined ? (
        <div className="mt-5 flex flex-col gap-3" aria-label="Loading">
          <div className="skeleton h-40 w-full" />
          <div className="skeleton h-40 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-5 rounded-box border border-base-300 px-5 py-6" data-testid="review-empty">
          <p className="font-medium">Nobody is held for review.</p>
          <p className="mt-1 text-base-content/65">When the app is unsure what happened with a person, it holds them here instead of guessing.</p>
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-base-300 rounded-box border border-base-300">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              heldAt={heldAt.get(item.id)}
              onResolved={(stage) => {
                setGone((set) => new Set(set).add(item.id));
                setNotice(`${item.person.fullName} ${CHOICE_DONE[stage]}.`);
                refresh();
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
    <li className="grid gap-x-8 gap-y-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="review-item" aria-label={person.fullName}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">{person.fullName}</h2>
          <a href={person.profileUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-sm text-base-content/75 link-hover">
            LinkedIn profile
            <IconExternal />
            <span className="sr-only">(opens in your browser)</span>
          </a>
        </div>
        {person.headline !== null && <p className="text-sm">{person.headline}</p>}
        <p className="text-sm text-base-content/65">
          In {item.campaignName}
          {heldAt === undefined ? "" : `, held ${formatWhen(heldAt, timeZone, now)}`}.
        </p>
        <p className="mt-3 rounded-field bg-accent/20 px-3 py-2">
          <span className="font-medium">Why: </span>
          {item.reviewReason === null ? "The app did not record a reason." : asSentence(item.reviewReason)}
        </p>
        <p className="mt-2 text-sm" data-testid="review-score">
          {item.score === null ? (
            <span className="text-base-content/75">Not scored</span>
          ) : (
            <>
              <span className="nums font-medium">Score {formatScore(item.score)} of 10</span>
              {item.scoreReason !== null && <span className="text-base-content/75">: {item.scoreReason}</span>}
            </>
          )}
        </p>
        <p className="mt-1 text-sm text-base-content/75">So far: {progress(item, timeZone, now)}</p>
        {item.screenshotUrl !== null && <Screenshot url={item.screenshotUrl} name={person.fullName} />}
      </div>

      <div className="flex flex-col gap-3">
        <fieldset className="text-sm">
          <legend className="mb-1.5 font-medium">What should happen next</legend>
          <div className="flex flex-col gap-1.5">
            {RESOLVE_STAGES.map((stage) => (
              <label key={stage} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  className="radio radio-sm mt-0.5"
                  name={choiceName}
                  value={stage}
                  checked={choice === stage}
                  disabled={busy}
                  onChange={() => setChoice(stage)}
                />
                <span>{CHOICE_LABEL[stage]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm" htmlFor={noteId}>
          <span>Note for the activity log (optional)</span>
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
            onClick={() => {
              if (choice !== null) resolve(choice);
            }}
          >
            {busy && <span className="loading loading-spinner loading-xs" />}
            Confirm
          </button>
          {choice === null && <p className="text-xs text-base-content/60">Choose what should happen first.</p>}
        </div>
        {error !== undefined && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
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
      <p className="mt-3 text-sm text-base-content/65" data-testid="screenshot-missing">
        A screenshot was saved, but the app could not show it.
      </p>
    );
  }

  return (
    <div className="mt-3">
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
      <dialog ref={ref} className="modal" aria-labelledby={titleId} onClose={() => setOpen(false)}>
        <div className="modal-box max-h-[92vh] w-11/12 max-w-6xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 id={titleId} className="font-semibold">
              Screenshot: {name}
            </h3>
            <button type="button" className="btn btn-sm btn-ghost border-base-300" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <img src={url} alt={alt} className="h-auto w-full" />
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit">Close</button>
        </form>
      </dialog>
    </div>
  );
}
