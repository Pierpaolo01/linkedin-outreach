import { Fragment, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createCampaign, getCampaign, startCampaign, toApiError, updateCampaign } from "../api";
import type { Campaign } from "../apiSchemas";
import { useAppData } from "../appData";
import {
  BLANK_FORM,
  FIELD_LABEL,
  formFromCampaign,
  sentUrls,
  stepOf,
  STEPS,
  toFields,
  withoutErrors,
  type CampaignForm,
  type FieldErrors,
  type FormKey,
  type SetField,
} from "../campaignForm";
import { MessageFields, TimingFields } from "../CampaignFields";
import { formatClock, joinWords, unbroken, withStop } from "../format";
import {
  ActionError,
  DEF_LIST,
  DEF_TERM,
  describedByError,
  EmptyState,
  errorProps,
  Field,
  FieldError,
  focusFirstError,
  focusInView,
  hintIdOf,
  LoadError,
  SECONDARY_BUTTON,
  SwitchRow,
} from "../formParts";
import { IconCheck } from "../icons";
import { Link, navigate } from "../router";
import { useLoad } from "../useLoad";
import { capitalised, failure, POLICY_WORDS, type Failure, type Said } from "../words";
import { PageHeader } from "./PageHeader";

/** The step names, in order: the six steps, then the review. */
const STEP_TITLES: readonly string[] = [...STEPS.map((s) => s.title), "Review and start"];

/** A step's number circle, on the strip and in the review. Add its fill. */
const STEP_CIRCLE = "nums flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold";
/**
 * The fill of a step the user has passed but not finished: Hairline Sage with a 1.5px Ink edge, drawn as an inset ring
 * so it stays 1.5px where a border would be rounded to whole pixels, and the circle keeps its 24px.
 */
const UNFINISHED_CIRCLE = "bg-base-300 ring-[1.5px] ring-base-content ring-inset";
/**
 * The fill of a step with a problem: its number in Stop Red inside a Stop Red edge, on the strip and in the review.
 * A form error, so never the filled red dot, which means a safety stop (and an error line in the activity log).
 */
const PROBLEM_CIRCLE = "border-2 border-error bg-base-100 text-error";

/** The space between two steps on the strip (`gap-1`). */
const STRIP_GAP = 4;
/** A step's number circle ends this far into the step (10px padding, 24px circle): a step cut before that shows a sliced circle. */
const CIRCLE_END = 34;

/**
 * The strip's mask: everything up to the first step that does not fit (`cut`, px from the strip's left) shows in full.
 * That step fades out as a sign that the strip scrolls, from 45% to nothing, when its number circle fits whole; when
 * the circle would be sliced, the step is hidden instead.
 */
function stripMask(cut: number | null, width: number): string | undefined {
  if (cut === null) return undefined;
  if (cut + CIRCLE_END > width) return `linear-gradient(to right, #000 ${cut}px, transparent ${cut}px)`;
  return `linear-gradient(to right, #000 ${cut}px, rgb(0 0 0 / 0.45) ${cut}px, transparent 100%)`;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The wizard's steps: a left column from 1024px, a strip that scrolls sideways below it. On the strip a line says
 * which step of how many this is, and the strip shows whole steps only: it snaps to a step's start at its left edge,
 * and when the step changes it scrolls just enough to show the current step in full, with the step before it either
 * whole or out of view. A step cut by the right edge fades out (or hides, rather than show a sliced number).
 */
function StepStrip(props: {
  readonly step: number;
  readonly furthest: number;
  readonly problems: ReadonlySet<number>;
  /** Steps still missing something Start needs: they never show the check, which means "nothing to fix here". */
  readonly unfinished: ReadonlySet<number>;
  readonly created: boolean;
  readonly onGo: (step: number) => void;
}) {
  const { step } = props;
  const strip = useRef<HTMLOListElement>(null);
  const spacer = useRef<HTMLLIElement>(null);
  const [mask, setMask] = useState<string | undefined>(undefined);
  const placed = useRef(false);

  const stepsOf = (ol: HTMLOListElement) => [...ol.querySelectorAll<HTMLElement>(":scope > li[data-step]")];
  /** The strip scrolls sideways (below 1024px) and has more steps than room. */
  const scrolls = (ol: HTMLOListElement) => getComputedStyle(ol).flexDirection === "row";

  const measure = () => {
    const ol = strip.current;
    if (ol === null) return;
    const steps = stepsOf(ol);
    const last = steps.at(-1);
    if (!scrolls(ol) || last === undefined) {
      setMask(undefined);
      return;
    }
    // Room after the last step, so every step (the last ones too) can stand at the left edge, where the strip snaps.
    if (spacer.current !== null) spacer.current.style.width = `${Math.max(0, ol.clientWidth - last.offsetWidth - STRIP_GAP)}px`;
    const right = ol.scrollLeft + ol.clientWidth;
    const cut = steps.find((li) => li.offsetLeft + li.offsetWidth > right + 1 && li.offsetLeft < right);
    setMask(stripMask(cut === undefined ? null : cut.offsetLeft - ol.scrollLeft, ol.clientWidth));
  };

  const remeasure = useEffectEvent(measure);
  useEffect(() => {
    const ol = strip.current;
    if (ol === null) return;
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(ol);
    return () => observer.disconnect();
  }, []);

  // Show the current step in full, with the step before it whole when both fit. Only the strip scrolls, never the page.
  useEffect(() => {
    const ol = strip.current;
    if (ol === null || !scrolls(ol)) return;
    const steps = stepsOf(ol);
    const here = steps[step];
    if (here === undefined) return;
    const before = steps[step - 1];
    const inView = here.offsetLeft >= ol.scrollLeft - 1 && here.offsetLeft + here.offsetWidth <= ol.scrollLeft + ol.clientWidth + 1;
    const beforeWhole = before === undefined || before.offsetLeft >= ol.scrollLeft - 1 || before.offsetLeft + before.offsetWidth <= ol.scrollLeft + 1;
    const first = !placed.current;
    placed.current = true;
    if (!(inView && beforeWhole)) {
      const withBefore = before !== undefined && here.offsetLeft + here.offsetWidth - before.offsetLeft <= ol.clientWidth;
      ol.scrollTo({ left: withBefore ? before.offsetLeft : here.offsetLeft, behavior: first || reducedMotion() ? "instant" : "smooth" });
    }
    remeasure();
  }, [step]);

  return (
    <nav aria-label="Wizard steps" className="min-w-0">
      <p className="mb-2 text-sm text-muted lg:hidden">
        Step {step + 1} of {STEP_TITLES.length}: {STEP_TITLES[step]}
      </p>
      <ol
        ref={strip}
        onScroll={measure}
        style={mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
        className="relative flex snap-x snap-mandatory gap-1 overflow-x-auto pb-1 lg:snap-none lg:flex-col lg:overflow-visible"
      >
        {STEP_TITLES.map((title, index) => {
          const here = index === step;
          const problem = props.problems.has(index);
          const done = !here && !problem && !props.unfinished.has(index) && index < props.furthest;
          // Passed and still missing what Start needs: an Ink edge sets it apart from the steps not reached yet. Not amber
          // (nothing waits on the user yet) and not red (nothing is wrong yet).
          const passedOpen = !here && !problem && props.unfinished.has(index) && index < props.furthest;
          return (
            <li key={title} data-step={index} className="shrink-0 snap-start">
              <button
                type="button"
                disabled={!props.created && index > 0}
                aria-current={here ? "step" : undefined}
                onClick={() => props.onGo(index)}
                className={`relative flex w-full items-center gap-2.5 rounded-field px-2.5 py-2 text-left text-sm max-lg:min-h-11 ${
                  here ? "bg-neutral text-neutral-content" : "hover:bg-base-200 disabled:text-muted"
                }`}
              >
                <span
                  className={`${STEP_CIRCLE} ${
                    problem
                      ? PROBLEM_CIRCLE
                      : here
                        ? "bg-neutral-content text-neutral"
                        : done
                          ? "bg-score-high text-primary"
                          : passedOpen
                            ? UNFINISHED_CIRCLE
                            : "bg-base-300"
                  }`}
                  aria-hidden="true"
                >
                  {done ? <IconCheck className="size-3.5" /> : index + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="whitespace-nowrap">{title}</span>
                  {/* In the step list (from 1024px) a passed, unfinished step says so in words under its name; the
                      phone strip keeps one line per step and says it to screen readers only. */}
                  {passedOpen && (
                    <span className="hidden text-caption text-muted lg:block" data-testid="step-not-finished">
                      Not finished
                    </span>
                  )}
                  {/* A refused step says so the same way, in the error tone (on the current step, in its own ink). */}
                  {problem && (
                    <span className={`hidden text-caption lg:block ${here ? "" : "text-error"}`} data-testid="step-needs-attention">
                      Needs attention
                    </span>
                  )}
                </span>
                {problem && <span className="sr-only lg:hidden">(needs attention)</span>}
                {done && <span className="sr-only">(done)</span>}
                {passedOpen && <span className="sr-only lg:hidden">(not finished)</span>}
              </button>
            </li>
          );
        })}
        <li ref={spacer} aria-hidden="true" className="shrink-0 lg:hidden" />
      </ol>
    </nav>
  );
}

const SEARCH_PREFIX = "https://www.linkedin.com/search/results/people/";
const MAX_SEARCHES = 20;
const REVIEW = STEPS.length;
const ALL_KEYS: readonly FormKey[] = STEPS.flatMap((step) => step.keys);

/**
 * The campaign wizard, for a new campaign (`/campaigns/new`) or a draft (`/campaigns/:id/edit`).
 * Creating the draft moves the address to the draft's own; the form stays as it is.
 */
export function CampaignWizard({ id }: { readonly id?: string }) {
  const address = id ?? "new";
  const [visit, setVisit] = useState<{ readonly generation: number; readonly created: number | null; readonly address: string }>({
    generation: 0,
    created: null,
    address,
  });
  if (visit.address !== address) {
    // Another address: a fresh form, unless it is the draft just created on this page.
    const own = visit.created !== null && address === String(visit.created);
    setVisit({ generation: own ? visit.generation : visit.generation + 1, created: own ? visit.created : null, address });
  }
  const onCreated = (newId: number) => {
    flushSync(() => setVisit((v) => ({ ...v, created: newId })));
    navigate(`/campaigns/${newId}/edit`);
  };
  return <Wizard key={visit.generation} id={id === undefined ? null : Number(id)} onCreated={onCreated} />;
}

/** The first step that still needs something, for a draft opened again. */
function firstOpenStep(c: Campaign): number {
  if (c.name.trim() === "") return 0;
  if (c.discoverySource === "search" && c.sourceUrls.length === 0) return 1;
  if (c.scoringBrief.trim() === "") return 2;
  if (c.firstMessage.trim() === "") return 4;
  return REVIEW;
}

const stepJson = (form: CampaignForm, step: number) => JSON.stringify((STEPS[step]?.keys ?? []).map((key) => form[key]));
const allSaved = (form: CampaignForm) => new Map(STEPS.map((_, s) => [s, stepJson(form, s)] as const));

/** What Start checks the app kept exactly as the review shows: the brief, the texts and the timings. */
const CHECKED_KEYS: readonly FormKey[] = [...STEPS[2].keys, ...STEPS[4].keys, ...STEPS[5].keys];

/** The checked fields whose saved value differs from the form's, compared as they are sent. */
function keptDifferently(form: CampaignForm, kept: Campaign): FormKey[] {
  const keptForm = formFromCampaign(kept);
  return CHECKED_KEYS.filter((key) => JSON.stringify(toFields(form, [key]).fields) !== JSON.stringify(toFields(keptForm, [key]).fields));
}

/**
 * A save that went through, or not: `failed` when the app did not take it at all (no field to mark), else it was
 * refused, with the paths of the fields it marked (`sourceUrls.0`), by the page or by the app.
 */
type SaveResult =
  | { readonly ok: true; readonly campaign: Campaign }
  | { readonly ok: false; readonly failed: true }
  | { readonly ok: false; readonly failed: false; readonly marked: readonly string[] };

/** A save waiting for its turn. Its values are read from the form only when it is sent. */
interface WaitingSave {
  readonly keys: Set<FormKey>;
  quiet: boolean;
  readonly done: ((result: SaveResult) => void)[];
}

/**
 * Every save of one draft, one request at a time. `waiting` is the one save not yet sent: a newer
 * save takes it over (its fields join), so a superseded save is never sent with old values.
 */
interface SaveQueue {
  tail: Promise<void>;
  waiting: WaitingSave | null;
  campaignId: number | null;
  /** The app's copy of the campaign as the last save that went through returned it. */
  lastSaved: Campaign | null;
}

/**
 * The header's word on the draft: "Saving…" while a save the user asked for runs; after a save that went wrong (and
 * none since that went through), "Not saved." with when it last was; else when it was saved, or "Draft" once it exists.
 */
function saveState(args: { readonly saving: boolean; readonly notSaved: boolean; readonly savedAt: string | null; readonly created: boolean }): string | undefined {
  if (args.saving) return "Saving…";
  if (args.notSaved) return args.savedAt === null ? "Not saved yet." : `Not saved. Last saved at ${args.savedAt}.`;
  if (args.savedAt !== null) return `Draft saved at ${args.savedAt}`;
  return args.created ? "Draft" : undefined;
}

function Wizard({ id, onCreated }: { readonly id: number | null; readonly onCreated: (id: number) => void }) {
  const { home, refresh, timeZone } = useAppData();
  const stopped = home?.safetyStop != null;
  const loaded = useLoad(() => (id === null ? Promise.resolve(null) : getCampaign(id).then((r) => r.campaign)), `wizard-${id ?? "new"}`);
  const [campaignId, setCampaignId] = useState<number | null>(id);
  const [form, setForm] = useState<CampaignForm | null>(id === null ? BLANK_FORM : null);
  /** The form as last drawn, for a save that is sent later than it was asked for. */
  const formNow = useRef(form);
  useLayoutEffect(() => {
    formNow.current = form;
  });
  const queue = useRef<SaveQueue>({ tail: Promise.resolve(), waiting: null, campaignId: id, lastSaved: null });
  const [status, setStatus] = useState<Campaign["status"]>("draft");
  const [step, setStep] = useState(0);
  /** Whether the user has moved between steps: only then does the new step fade in (never on page load). */
  const [stepMoved, setStepMoved] = useState(false);
  /** The furthest step the user has reached: the steps before it are done unless they show a problem. */
  const [furthest, setFurthest] = useState(0);
  if (step > furthest) setFurthest(step);
  const [errors, setErrors] = useState<FieldErrors>({});
  /** Saves asked for by a button that have not finished yet. */
  const [loudSaves, setLoudSaves] = useState(0);
  const saving = loudSaves > 0;
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  /**
   * The last save the user saw go wrong (refused with marked fields, or failed) has not been followed by one that went
   * through: the header then says the draft is not saved, never "Draft saved at" above "The draft was not saved".
   */
  const [notSaved, setNotSaved] = useState(false);
  /** What came back when a save of the draft failed with no field to mark; the page says the rest. */
  const [saveFailed, setSaveFailed] = useState<Said | undefined>(undefined);
  const [startError, setStartError] = useState<string | Failure | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  /** Refused Starts and refused step changes: each one moves the focus (and the view) to what needs fixing, once it shows. */
  const [startRefusals, setStartRefusals] = useState(0);
  const [stepRefusals, setStepRefusals] = useState(0);
  const stepBody = useRef<HTMLDivElement>(null);
  /** What each step held when it was last saved, so the background save skips unchanged steps. */
  const [saved, setSaved] = useState<ReadonlyMap<number, string>>(new Map());

  // A draft opened again: fill the form once, from the app's copy.
  if (form === null && loaded.data != null) {
    const campaign = loaded.data;
    const filled = formFromCampaign(campaign);
    setForm(filled);
    setStatus(campaign.status);
    setStep(firstOpenStep(campaign));
    setSaved(allSaved(filled));
  }

  /** Sends one save with the form as it is now. Never throws. */
  const send = async (job: WaitingSave): Promise<SaveResult> => {
    const snapshot = formNow.current;
    if (snapshot === null) return { ok: false, failed: false, marked: [] };
    const keys = [...job.keys];
    const { fields, errors: local } = toFields(snapshot, keys);
    if (Object.keys(local).length > 0) {
      if (!job.quiet) {
        setErrors((e) => ({ ...e, ...local }));
        setNotSaved(true);
      }
      return { ok: false, failed: false, marked: Object.keys(local) };
    }
    setSaveFailed(undefined);
    try {
      let campaign: Campaign;
      if (queue.current.campaignId === null) {
        ({ campaign } = await createCampaign(fields));
        queue.current.campaignId = campaign.id;
        const filled = { ...formFromCampaign(campaign), name: snapshot.name };
        // A save waiting behind this one is sent before the next draw: give it the filled form.
        formNow.current = filled;
        setCampaignId(campaign.id);
        setForm(filled);
        setSaved(allSaved(filled));
        onCreated(campaign.id);
        refresh();
      } else {
        ({ campaign } = await updateCampaign(queue.current.campaignId, fields));
        setSaved((map) => {
          const next = new Map(map);
          for (const [s, { keys: stepKeys }] of STEPS.entries()) if (stepKeys.every((key) => job.keys.has(key))) next.set(s, stepJson(snapshot, s));
          return next;
        });
      }
      queue.current.lastSaved = campaign;
      setSavedAt(new Date());
      setNotSaved(false);
      return { ok: true, campaign };
    } catch (failure) {
      const error = toApiError(failure);
      const refused = Object.keys(error.fields).length > 0;
      if (refused) setErrors((e) => ({ ...e, ...error.fields }));
      else setSaveFailed(error);
      setNotSaved(true);
      return refused ? { ok: false, failed: false, marked: Object.keys(error.fields) } : { ok: false, failed: true };
    }
  };

  /** Puts a save in the queue; it resolves once that save (or the newer one that took it over) is done. */
  const save = (keys: readonly FormKey[], { quiet = false } = {}): Promise<SaveResult> => {
    if (!quiet) setLoudSaves((n) => n + 1);
    const result = new Promise<SaveResult>((resolve) => {
      const waiting = queue.current.waiting;
      if (waiting !== null) {
        for (const key of keys) waiting.keys.add(key);
        waiting.quiet &&= quiet;
        waiting.done.push(resolve);
        return;
      }
      const job: WaitingSave = { keys: new Set(keys), quiet, done: [resolve] };
      queue.current.waiting = job;
      queue.current.tail = queue.current.tail.then(async () => {
        // From here on it is on its way; a save asked for now waits behind it.
        queue.current.waiting = null;
        const outcome = await send(job).catch((): SaveResult => ({ ok: false, failed: true }));
        for (const done of job.done) done(outcome);
      });
    });
    return quiet ? result : result.finally(() => setLoudSaves((n) => n - 1));
  };

  /** Waits until no save is on its way or waiting. */
  const drain = async () => {
    let tail: Promise<void>;
    do {
      tail = queue.current.tail;
      await tail;
    } while (tail !== queue.current.tail || queue.current.waiting !== null);
  };

  // After a step change the keyboard and a screen reader land on the new step's heading (the Name field keeps its own
  // focus when the wizard first opens). As with a page title, the heading takes focus from the script only: no ring.
  useEffect(() => {
    if (stepMoved) document.getElementById(STEP_TITLE_ID)?.focus({ preventScroll: true });
  }, [step, stepMoved]);

  // A refused Start: the summary above the review takes the focus and comes into view, wherever Start was pressed; when
  // its save failed with nothing to mark, the failed save's message does.
  useEffect(() => {
    const summary = document.getElementById(START_ERROR_ID) ?? document.getElementById(SAVE_ERROR_ID);
    if (startRefusals > 0 && summary !== null) focusInView(summary);
  }, [startRefusals]);
  // A refused step change: the first field the step marked takes the focus, as a refused save does in Settings.
  // With no field marked (the request failed), the save's message above the step takes it instead.
  useEffect(() => {
    if (stepRefusals === 0 || stepBody.current === null) return;
    if (focusFirstError(stepBody.current)) return;
    const failed = document.getElementById(SAVE_ERROR_ID);
    if (failed !== null) focusInView(failed);
  }, [stepRefusals]);

  // Save the current step in the background once typing pauses, so nothing is lost.
  const current = form === null || step >= REVIEW ? "" : stepJson(form, step);
  const saveQuietly = useEffectEvent((keys: readonly FormKey[]) => void save(keys, { quiet: true }));
  const unsaved = campaignId !== null && current !== "" && step < REVIEW && saved.get(step) !== current;
  useEffect(() => {
    if (!unsaved) return;
    const timer = setTimeout(() => saveQuietly(STEPS[step]?.keys ?? []), 1200);
    return () => clearTimeout(timer);
  }, [unsaved, current, step]);

  if (form === null) {
    if (loaded.status === "error") return <LoadError what="the campaign" error={loaded.error} onRetry={loaded.reload} />;
    return (
      <>
        <PageHeader title="New campaign" />
        <div className="skeleton h-72 w-full" />
      </>
    );
  }

  if (status !== "draft" && campaignId !== null) {
    return (
      <>
        <PageHeader title={form.name} />
        <EmptyState
          className="max-w-xl"
          title="This campaign has already started."
          action={
            <Link to={`/campaigns/${campaignId}`} className={`${SECONDARY_BUTTON} btn-sm`}>
              Open the campaign
            </Link>
          }
        >
          Its messages and timings can still change on its page; the rest stays as it started.
        </EmptyState>
      </>
    );
  }

  const set: SetField = (key, value) => {
    setForm((f) => (f === null ? f : { ...f, [key]: value }));
    setErrors((e) => withoutErrors(e, key));
  };

  const goTo = async (next: number) => {
    if (next === step) return;
    if (step < REVIEW) {
      if (step === 0 && form.name.trim() === "") {
        setErrors((e) => ({ ...e, name: "Give the campaign a name" }));
        setStepRefusals((n) => n + 1);
        return;
      }
      const { ok } = await save(STEPS[step]?.keys ?? []);
      await drain();
      // Going back never waits on a problem; going on does.
      if (!ok && next > step) {
        setStepRefusals((n) => n + 1);
        return;
      }
    }
    setStepMoved(true);
    setStep(next);
    window.scrollTo(0, 0);
  };

  const start = async () => {
    if (campaignId === null) return;
    setStarting(true);
    setStartError(undefined);
    const saved = await save(ALL_KEYS);
    await drain();
    const stop = (message: string | undefined) => {
      setStarting(false);
      setStartError(message);
      setStartRefusals((n) => n + 1);
    };
    if (!saved.ok) {
      // A save that failed with nothing to mark is said once, by the failed save's message above the review (the
      // pattern of every failure: not saved, still on this page, press Start the campaign again), which takes the focus.
      if (saved.failed) {
        stop(undefined);
        return;
      }
      const marked = stepTitlesOf(saved.marked);
      stop(
        marked.length > 0
          ? `Nothing was saved: some answers need attention. Fix ${joinWords(marked)}, marked below, then press Start the campaign again.`
          : "Nothing was saved: some answers need attention. Fix what is marked below, then press Start the campaign again.",
      );
      return;
    }
    // Start only what the review shows: the app's copy after the last save must hold exactly these values.
    const shown = formNow.current;
    const kept = queue.current.lastSaved;
    const differ = shown === null || kept === null ? CHECKED_KEYS : keptDifferently(shown, kept);
    if (differ.length > 0) {
      const labels = [...new Set(differ.map((key) => FIELD_LABEL[key]))].join(", ");
      stop(`The campaign was not started: the app’s copy of the draft differs from this page (${labels}). Press Start the campaign again to save this page and check once more.`);
      return;
    }
    try {
      await startCampaign(campaignId);
      refresh();
      navigate(`/campaigns/${campaignId}`);
    } catch (failed) {
      const error = toApiError(failed);
      setErrors(error.fields);
      const marked = stepTitlesOf(Object.keys(error.fields));
      setStartError(
        Object.keys(error.fields).length === 0
          ? failure("The campaign did not start. The draft is saved; press Start the campaign again.", error)
          : marked.length > 0
            ? `The campaign cannot start yet. Fix ${joinWords(marked)}, marked below, then press Start the campaign again.`
            : "The campaign cannot start yet. Fix what is marked below, then press Start the campaign again.",
      );
      setStartRefusals((n) => n + 1);
    } finally {
      setStarting(false);
    }
  };

  const stepsWithProblems = new Set(Object.keys(errors).map(stepOf));
  const stepsUnfinished = unfinishedSteps(form);
  /** The unfinished steps by name, in order, for the sentence by Start. */
  const stillOpen = [...stepsUnfinished].sort((a, b) => a - b).flatMap((s) => STEPS[s]?.title ?? []);
  const created = campaignId !== null;

  return (
    <>
      <PageHeader
        title="New campaign"
        aside={saveState({ saving, notSaved, savedAt: savedAt === null ? null : formatClock(savedAt.toISOString(), timeZone), created })}
      />
      <div className="grid gap-section lg:grid-cols-[13rem_minmax(0,1fr)]">
        <StepStrip step={step} furthest={furthest} problems={stepsWithProblems} unfinished={stepsUnfinished} created={created} onGo={(index) => void goTo(index)} />

        <div className="min-w-0">
          <ActionError
            message={
              saveFailed === undefined
                ? undefined
                : failure(
                    `The draft was not saved. Your changes are still on this page; press ${step < REVIEW ? (step === REVIEW - 1 ? "Save and review" : "Save and continue") : "Start the campaign"} again.`,
                    saveFailed,
                  )
            }
            className="mb-group"
            testId="save-error"
            id={SAVE_ERROR_ID}
          />
          <div key={step} ref={stepBody} className={stepMoved ? "animate-appear" : undefined}>
            {step === 0 && <NameStep form={form} set={set} errors={errors} onEnter={() => void goTo(1)} />}
            {step === 1 && <SourceStep form={form} set={set} errors={errors} />}
            {step === 2 && <WhoFitsStep form={form} set={set} errors={errors} />}
            {step === 3 && <ApprovalStep form={form} set={set} errors={errors} />}
            {step === 4 && campaignId !== null && (
              <StepFrame title="Messages" lead="Write what each person receives. Every word is yours; the variables fill in each person’s details.">
                <MessageFields campaignId={campaignId} form={form} set={set} errors={errors} />
              </StepFrame>
            )}
            {step === 5 && (
              <StepFrame title="Timings" lead="How long the app waits between the steps, and when it gives up on an invite.">
                <TimingFields form={form} set={set} errors={errors} />
              </StepFrame>
            )}
            {step === REVIEW && <Review form={form} errors={errors} startError={startError} onChange={(s) => void goTo(s)} />}
          </div>

          <div className="mt-section flex flex-wrap items-center gap-3 border-t border-base-300 pt-block">
            {step === REVIEW && stillOpen.length > 0 && (
              // Said before Start is pressed, in Ink and plain: nothing is wrong yet, it is only not done.
              <p id={UNFINISHED_ID} className="basis-full text-sm" data-testid="start-unfinished">
                {joinWords(stillOpen)} {stillOpen.length === 1 ? "is" : "are"} not finished yet.
              </p>
            )}
            {step > 0 && (
              <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={saving || starting} onClick={() => void goTo(step - 1)}>
                Back
              </button>
            )}
            {step < REVIEW ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={saving} aria-busy={saving} onClick={() => void goTo(step + 1)}>
                {saving && <span className="loading loading-spinner loading-xs" />}
                {step === REVIEW - 1 ? "Save and review" : "Save and continue"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={starting}
                aria-busy={starting}
                aria-describedby={stillOpen.length > 0 ? UNFINISHED_ID : undefined}
                onClick={() => void start()}
              >
                {starting && <span className="loading loading-spinner loading-sm" />}
                Start the campaign
              </button>
            )}
            {step === REVIEW && (
              // During a safety stop nothing runs on LinkedIn until the user resumes, so a started campaign does not find people yet.
              <p className="text-sm text-muted" data-testid="start-note">
                Once started, the campaign begins finding people{stopped ? " when you resume" : ""}. {form.autoApprove
                  ? "Everyone who reaches the score threshold is invited and messaged without your review"
                  : "Nobody is invited before you approve them"}
                .
              </p>
            )}
          </div>
        </div>
      </div>

    </>
  );
}

// ------------------------------------------------------------ steps

interface StepProps {
  readonly form: CampaignForm;
  readonly set: SetField;
  readonly errors: FieldErrors;
}

/** The steps still missing what Start requires (a name, a search when the source is searches, who fits, the first message). */
function unfinishedSteps(form: CampaignForm): ReadonlySet<number> {
  const empty = (value: string) => value.trim() === "";
  const missing: readonly (readonly [number, boolean])[] = [
    [0, empty(form.name)],
    [1, form.discoverySource === "search" && sentUrls(form.sourceUrls).length === 0],
    [2, empty(form.scoringBrief)],
    [4, empty(form.firstMessage)],
  ];
  return new Set(missing.flatMap(([step, gap]) => (gap ? [step] : [])));
}

/** The id of the current step's heading, which takes the focus when the step changes. */
const STEP_TITLE_ID = "step-title";
/** The id of the summary of a refused Start, which takes the focus. */
const START_ERROR_ID = "start-error";
/** The id of a failed save's message above the step, which takes the focus when no field is marked. */
const SAVE_ERROR_ID = "save-error";
/** The id of the sentence by Start that names the unfinished steps. */
const UNFINISHED_ID = "start-unfinished";

/** The names of the steps that hold these fields (`sourceUrls.0`, `firstMessage`), once each, in order. */
function stepTitlesOf(paths: readonly string[]): string[] {
  return [...new Set(paths.map(stepOf))]
    .filter((s) => s < REVIEW)
    .sort((a, b) => a - b)
    .flatMap((s) => STEPS[s]?.title ?? []);
}

function StepFrame({ title, lead, children }: { readonly title: string; readonly lead: string; readonly children: ReactNode }) {
  return (
    <section aria-labelledby={STEP_TITLE_ID}>
      <h2 id={STEP_TITLE_ID} tabIndex={-1} className="text-xl font-semibold">
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-base-content">{lead}</p>
      <div className="mt-block">{children}</div>
    </section>
  );
}

function NameStep({ form, set, errors, onEnter }: StepProps & { readonly onEnter: () => void }) {
  const inputId = useId();
  return (
    <StepFrame title="Name" lead="A name for you to recognise the campaign by. Nobody else sees it.">
      <Field label="Campaign name" htmlFor={inputId} error={errors["name"]} className="max-w-md">
        <input
          id={inputId}
          className={`input w-full bg-base-100 ${errors["name"] === undefined ? "" : "input-error"}`}
          value={form.name}
          maxLength={200}
          autoFocus
          onChange={(event) => set("name", event.target.value)}
          {...errorProps(inputId, errors["name"])}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter();
          }}
        />
      </Field>
    </StepFrame>
  );
}

function SourceStep({ form, set, errors }: StepProps) {
  const radioName = useId();
  const countId = useId();
  const urls = form.sourceUrls.length === 0 ? [""] : form.sourceUrls;
  const setUrls = (next: readonly string[]) => set("sourceUrls", next);
  // The app numbers problems by the addresses it was sent: the non-empty ones, in order.
  const sentIndex = urls.map((_, i) => urls.slice(0, i).filter((u) => u.trim() !== "").length);
  return (
    <StepFrame title="Where people come from" lead="Where the app looks for people to score for this campaign.">
      <fieldset className="flex max-w-2xl flex-col gap-3">
        <legend className="sr-only">Source</legend>
        {(
          [
            ["recommendations", "LinkedIn’s recommendations", "The people LinkedIn suggests to you on its My Network page."],
            ["search", "People searches", "One or more searches you set up on LinkedIn, with the filters you want."],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-box border px-4 py-3 ${form.discoverySource === value ? "border-primary bg-score-high/40" : "border-base-300"}`}
          >
            <input
              type="radio"
              name={radioName}
              className="radio radio-sm radio-primary mt-0.5"
              checked={form.discoverySource === value}
              onChange={() => set("discoverySource", value)}
              {...describedByError(radioName, errors["discoverySource"])}
            />
            <span>
              <span className="block font-medium">{label}</span>
              <span className="block text-sm text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FieldError controlId={radioName} message={errors["discoverySource"]} />

      {form.discoverySource === "search" && (
        <div className="mt-block max-w-2xl">
          <p className="font-medium">Search addresses</p>
          <p id={hintIdOf(`${countId}-urls`)} className="text-sm text-muted">
            Run the search on LinkedIn, then copy the address from your browser&rsquo;s address bar and paste it here. It must start with{" "}
            <span className="font-medium break-all">{SEARCH_PREFIX}</span>
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {urls.map((url, index) => {
              const serverError = url.trim() === "" ? undefined : errors[`sourceUrls.${sentIndex[index] ?? index}`];
              const looksWrong = url.trim() !== "" && !url.trim().startsWith(SEARCH_PREFIX);
              const urlId = `${countId}-url-${index}`;
              return (
                <li key={index}>
                  <div className="flex gap-2">
                    <input
                      id={urlId}
                      aria-label={`Search address ${index + 1}`}
                      {...errorProps(urlId, serverError, { hint: hintIdOf(`${countId}-urls`) })}
                      className={`input min-w-0 flex-1 bg-base-100 ${serverError === undefined ? "" : "input-error"}`}
                      value={url}
                      placeholder={SEARCH_PREFIX}
                      onChange={(event) => setUrls(urls.map((u, i) => (i === index ? event.target.value : u)))}
                    />
                    {urls.length > 1 && (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        aria-label={`Remove search address ${index + 1}`}
                        onClick={() => setUrls(urls.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {serverError !== undefined ? (
                    <FieldError controlId={urlId} message={serverError} />
                  ) : (
                    looksWrong && <p className="mt-1 text-sm text-base-content">This address does not start with {SEARCH_PREFIX}</p>
                  )}
                </li>
              );
            })}
          </ul>
          <FieldError message={errors["sourceUrls"]} />
          {urls.length < MAX_SEARCHES && (
            <button type="button" className={`${SECONDARY_BUTTON} btn-sm mt-3`} onClick={() => setUrls([...urls, ""])}>
              Add another search
            </button>
          )}
        </div>
      )}

      <Field
        className="mt-block max-w-md"
        label="How many people to find"
        htmlFor={countId}
        hint="Leave it empty to keep finding until you pause the campaign. People rejected do not count."
        error={errors["targetProspectCount"]}
      >
        <input
          id={countId}
          inputMode="numeric"
          className={`input w-32 bg-base-100 nums ${errors["targetProspectCount"] === undefined ? "" : "input-error"}`}
          value={form.targetProspectCount}
          onChange={(event) => set("targetProspectCount", event.target.value)}
          {...errorProps(countId, errors["targetProspectCount"], { hint: hintIdOf(countId) })}
        />
      </Field>
    </StepFrame>
  );
}

function WhoFitsStep({ form, set, errors }: StepProps) {
  const briefId = useId();
  return (
    <StepFrame title="Who fits" lead="The AI reads this to score each person from 0 to 10, and tells you why.">
      <label htmlFor={briefId} className="block font-medium">
        Who fits this campaign, and who does not
      </label>
      <div id={hintIdOf(briefId)} className="mt-1 max-w-3xl text-sm text-muted">
        <p>Write who you want to reach: their role or whether they own the business, the industries, the places and the company size.</p>
        <p>Then write the signs of a good fit, and who to leave out.</p>
      </div>
      <textarea
        id={briefId}
        rows={14}
        className={`textarea mt-2 w-full max-w-3xl bg-base-100 text-base ${errors["scoringBrief"] === undefined ? "" : "textarea-error"}`}
        value={form.scoringBrief}
        onChange={(event) => set("scoringBrief", event.target.value)}
        {...errorProps(briefId, errors["scoringBrief"], { hint: hintIdOf(briefId) })}
      />
      <FieldError controlId={briefId} message={errors["scoringBrief"]} />
    </StepFrame>
  );
}

function ApprovalStep({ form, set, errors }: StepProps) {
  const ids = { batch: useId(), score: useId(), open: useId(), auto: useId() };
  const numberBox = (id: string, key: "batchSize" | "scoreThreshold" | "openProfileThreshold") => (
    <input
      id={id}
      inputMode="numeric"
      className={`input w-24 bg-base-100 nums ${errors[key] === undefined ? "" : "input-error"}`}
      value={form[key]}
      onChange={(event) => set(key, event.target.value)}
      {...errorProps(id, errors[key], { hint: hintIdOf(id) })}
    />
  );
  return (
    <StepFrame title="Approval" lead="How the people the app finds reach you, and which ones it rejects by itself.">
      <div className="flex max-w-2xl flex-col gap-block">
        <Field
          label="Batch size"
          htmlFor={ids.batch}
          hint="How many scored people the app gathers before it waits for you in the approval queue."
          error={errors["batchSize"]}
        >
          {numberBox(ids.batch, "batchSize")}
        </Field>
        <Field
          label="Score threshold, 0 to 10"
          htmlFor={ids.score}
          hint="The lowest score that reaches your approval queue. People who score lower are rejected without asking you."
          error={errors["scoreThreshold"]}
        >
          {numberBox(ids.score, "scoreThreshold")}
        </Field>
        <Field
          label="Open-profile threshold, 0 to 10"
          htmlFor={ids.open}
          hint="The app first scores the short summary LinkedIn shows in a list. Below this score it rejects the person without opening their profile, which saves profile views. It must not be above the score threshold."
          error={errors["openProfileThreshold"]}
        >
          {numberBox(ids.open, "openProfileThreshold")}
        </Field>
        <div className="rounded-box border border-base-300 px-4 py-4">
          <SwitchRow
            id={ids.auto}
            label="Auto-approve"
            checked={form.autoApprove}
            error={errors["autoApprove"]}
            onChange={(on) => set("autoApprove", on)}
            hint={form.autoApprove ? "On: the app invites and messages everyone who reaches the score threshold." : "Off: you approve each person before the app invites them."}
          />
          <FieldError controlId={ids.auto} message={errors["autoApprove"]} />
        </div>
      </div>
    </StepFrame>
  );
}

// ------------------------------------------------------------ review

function Review({
  form,
  errors,
  startError,
  onChange,
}: {
  readonly form: CampaignForm;
  readonly errors: FieldErrors;
  readonly startError: string | Failure | undefined;
  readonly onChange: (step: number) => void;
}) {
  const urls = sentUrls(form.sourceUrls);
  const unfinished = unfinishedSteps(form);
  /** A field's error with the field named before it ("Invite note: …"), for a line that does not sit under that field's own row. */
  const named = (path: string, message: string) => {
    const [key = "", index] = path.split(".");
    const label = key === "sourceUrls" && index !== undefined ? "Search address" : (Object.entries(FIELD_LABEL).find(([name]) => name === key)?.[1] ?? key);
    return withStop(`${label}${index === undefined ? "" : ` ${Number(index) + 1}`}: ${message}`);
  };
  const problems = (step: number) => Object.entries(errors).filter(([path]) => stepOf(path) === step);
  const text = (value: string, empty: string) => (value.trim() === "" ? <span className="text-muted">{empty}</span> : <span className="whitespace-pre-line">{value}</span>);
  /** What Start still needs: in Ink at 500, so the step that lacks it is not the quietest row. Not red before Start is pressed. */
  const needed = (value: string, empty: string) => (value.trim() === "" ? <span className="font-medium">{empty}</span> : text(value, empty));

  /** Each step's rows: the label, the value, and the fields whose errors sit under that value, without the label again. */
  const sections: readonly { readonly step: number; readonly rows: readonly (readonly [string, ReactNode, readonly FormKey[]])[] }[] = [
    { step: 0, rows: [["Name", needed(form.name, "No name yet"), ["name"]]] },
    {
      step: 1,
      rows: [
        ["Source", form.discoverySource === "search" ? "People searches" : "LinkedIn’s recommendations", ["discoverySource"]],
        ...(form.discoverySource === "search"
          ? [["Searches", urls.length === 0 ? <span className="font-medium">None yet</span> : <ul className="break-all">{urls.map((u) => <li key={u}>{u}</li>)}</ul>, ["sourceUrls"]] as const]
          : []),
        ["People to find", form.targetProspectCount.trim() === "" ? "No limit" : form.targetProspectCount, ["targetProspectCount"]],
      ],
    },
    { step: 2, rows: [["Who fits", needed(form.scoringBrief, "Not written yet"), ["scoringBrief"]]] },
    {
      step: 3,
      rows: [
        ["Batch size", form.batchSize, ["batchSize"]],
        ["Score threshold", form.scoreThreshold, ["scoreThreshold"]],
        ["Open-profile threshold", form.openProfileThreshold, ["openProfileThreshold"]],
        ["Auto-approve", form.autoApprove ? <span className="font-medium">On: people are invited without your review</span> : "Off: you approve each person", ["autoApprove"]],
      ],
    },
    {
      step: 4,
      rows: [
        ["Invite note", text(form.inviteNote, "No note"), ["inviteNote"]],
        ["First message", needed(form.firstMessage, "Not written yet"), ["firstMessage"]],
        ["Follow-up", text(form.followUp, "No follow-up"), ["followUp"]],
        ["AI-written line", form.aiPersonalise ? "On" : "Off", ["aiPersonalise"]],
      ],
    },
    {
      step: 5,
      rows: [
        ["Before the first message", `${unbroken(`${form.acceptToMessageMinHours} to ${form.acceptToMessageMaxHours} hours`)} after they accept`, ["acceptToMessageMinHours", "acceptToMessageMaxHours"]],
        ["Before the follow-up", `${unbroken(`${form.followUpDelayMinHours} to ${form.followUpDelayMaxHours} hours`)} after the first message`, ["followUpDelayMinHours", "followUpDelayMaxHours"]],
        ["Counting days", capitalised(POLICY_WORDS[form.delayPolicy]), ["delayPolicy"]],
        ["Withdraw an unaccepted invite after", unbroken(`${form.withdrawAfterDays} days`), ["withdrawAfterDays"]],
      ],
    },
  ];

  return (
    <section aria-labelledby={STEP_TITLE_ID}>
      <h2 id={STEP_TITLE_ID} tabIndex={-1} className="text-xl font-semibold">
        Review and start
      </h2>
      <p className="mt-1 max-w-2xl text-base-content">Check everything once more. The app checks it too when you press Start the campaign.</p>
      <ActionError message={startError} className="mt-block" testId="start-error" id={START_ERROR_ID} />
      <div className="mt-block divide-y divide-base-300 rounded-box border border-base-300">
        {sections.map(({ step, rows }) => {
          const all = problems(step);
          /** The errors of a row's fields, under its value; an indexed one ("Search address 2") keeps its name. */
          const under = (keys: readonly FormKey[]) =>
            all.flatMap(([path, message]) => {
              const [key = "", index] = path.split(".");
              if (!keys.some((k) => k === key)) return [];
              return [{ path, text: index === undefined ? withStop(capitalised(message)) : named(path, message) }];
            });
          const owned = new Set(rows.flatMap(([, , keys]) => under(keys).map((p) => p.path)));
          /** Errors with no row of their own (the AI line's instructions), named, under the list. */
          const list = all.filter(([path]) => !owned.has(path)).map(([path, message]) => ({ path, text: named(path, message) }));
          return (
            <div key={step} className="px-4 py-4" data-testid={`review-step-${step + 1}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 font-semibold">
                  {/* Every mark takes the number circle's box, so the step names start at one edge. */}
                  {all.length > 0 ? (
                    // A problem: the step's number in the strip's Stop Red edge, as the strip marks it. Not the filled red
                    // dot, which means a safety stop.
                    <span className={`${STEP_CIRCLE} ${PROBLEM_CIRCLE}`} aria-hidden="true" data-testid="review-mark">
                      {step + 1}
                    </span>
                  ) : unfinished.has(step) ? (
                    // Not done yet: the step's own number in its circle, as on the strip. Not a ring (a ring is a campaign
                    // that is not working), not amber and not red, since nothing is wrong yet.
                    <span className={`${STEP_CIRCLE} ${UNFINISHED_CIRCLE}`} aria-hidden="true" data-testid="review-mark">
                      {step + 1}
                    </span>
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
                      <IconCheck className="size-4 text-primary" />
                    </span>
                  )}
                  {STEPS[step]?.title}
                  {all.length > 0 && <span className="sr-only">(needs attention)</span>}
                  {all.length === 0 && unfinished.has(step) && <span className="sr-only">(not finished)</span>}
                </h3>
                <button type="button" className="link inline-flex min-h-6 shrink-0 items-center text-sm link-hover max-lg:min-h-11" onClick={() => onChange(step)}>
                  Change<span className="sr-only"> {STEPS[step]?.title}</span>
                </button>
              </div>
              <dl className={`mt-2 ${DEF_LIST} text-sm`}>
                {rows.map(([label, value, keys]) => {
                  // A row named like its step ("Name" under "Name") would say the heading twice: its label is for screen readers only.
                  const repeats = label === STEPS[step]?.title;
                  const own = under(keys);
                  return (
                    <Fragment key={label}>
                      <dt className={repeats ? "sr-only" : `${DEF_TERM} text-muted`}>{label}</dt>
                      <dd className={`min-w-0 wrap-break-word ${repeats ? "col-span-full" : ""}`}>
                        {value}
                        {/* The row's own error, under its value: the label beside it already names the field. */}
                        {own.map((p) => (
                          <p key={p.path} className="mt-1 text-error" data-testid="field-error">
                            {p.text}
                          </p>
                        ))}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
              {list.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1">
                  {list.map((p) => (
                    <li key={p.path} className="text-sm text-error" data-testid="field-error">
                      {p.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
