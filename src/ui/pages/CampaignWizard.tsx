import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { ConfirmDialog } from "../ConfirmDialog";
import { formatClock } from "../format";
import { ActionError, describedByError, EmptyState, errorProps, Field, FieldError, LoadError, Notice, SECONDARY_BUTTON, SwitchRow } from "../formParts";
import { IconCheck } from "../icons";
import { Link, navigate } from "../router";
import { useLoad } from "../useLoad";
import { POLICY_WORDS } from "../words";
import { PageHeader } from "./PageHeader";

/** The step names, in order: the six steps, then the review. */
const STEP_TITLES: readonly string[] = [...STEPS.map((s) => s.title), "Review and start"];

/** A fade at each end of the step strip that has more steps beyond it, so the strip says it scrolls. */
function stripMask(start: boolean, end: boolean): string | undefined {
  if (!start && !end) return undefined;
  const from = start ? "transparent, #000 2.5rem" : "#000";
  const to = end ? "#000 calc(100% - 2.5rem), transparent" : "#000";
  return `linear-gradient(to right, ${from}, ${to})`;
}

/**
 * The wizard's steps: a left column from 1024px, a strip that scrolls sideways below it. On the strip a line
 * says which step of how many this is, the current step is brought to the middle when it changes, and an
 * end fades while there are more steps past it.
 */
function StepStrip(props: {
  readonly step: number;
  readonly furthest: number;
  readonly problems: ReadonlySet<number>;
  readonly created: boolean;
  readonly onGo: (step: number) => void;
}) {
  const { step } = props;
  const strip = useRef<HTMLOListElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  const measure = () => {
    const ol = strip.current;
    if (ol === null) return;
    setMore({ start: ol.scrollLeft > 1, end: ol.scrollLeft + ol.clientWidth < ol.scrollWidth - 1 });
  };

  useEffect(() => {
    const ol = strip.current;
    if (ol === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(ol);
    return () => observer.disconnect();
  }, []);

  // Bring the current step to the middle of the strip. Only the strip scrolls, never the page.
  useEffect(() => {
    const ol = strip.current;
    const current = ol?.querySelector<HTMLElement>('[aria-current="step"]')?.parentElement;
    if (ol === null || ol === undefined || current === null || current === undefined || ol.scrollWidth <= ol.clientWidth) return;
    ol.scrollLeft = current.offsetLeft - (ol.clientWidth - current.offsetWidth) / 2;
    measure();
  }, [step]);

  const mask = stripMask(more.start, more.end);
  return (
    <nav aria-label="Wizard steps" className="min-w-0">
      <p className="mb-2 text-sm text-muted lg:hidden">
        Step {step + 1} of {STEP_TITLES.length}: {STEP_TITLES[step]}
      </p>
      <ol
        ref={strip}
        onScroll={measure}
        style={mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
        className="relative flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible"
      >
        {STEP_TITLES.map((title, index) => {
          const here = index === step;
          const problem = props.problems.has(index);
          const done = !here && !problem && index < props.furthest;
          return (
            <li key={title} className="shrink-0">
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
                  className={`nums flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    problem
                      ? "border-2 border-error bg-base-100 text-error"
                      : here
                        ? "bg-neutral-content text-neutral"
                        : done
                          ? "bg-score-high text-primary"
                          : "bg-base-300"
                  }`}
                  aria-hidden="true"
                >
                  {done ? <IconCheck className="size-3.5" /> : index + 1}
                </span>
                <span className="whitespace-nowrap">{title}</span>
                {problem && <span className="sr-only">(needs attention)</span>}
                {done && <span className="sr-only">(done)</span>}
              </button>
            </li>
          );
        })}
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

type SaveResult = { readonly ok: true; readonly campaign: Campaign } | { readonly ok: false };

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

function Wizard({ id, onCreated }: { readonly id: number | null; readonly onCreated: (id: number) => void }) {
  const { refresh, timeZone } = useAppData();
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
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
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
    if (snapshot === null) return { ok: false };
    const keys = [...job.keys];
    const { fields, errors: local } = toFields(snapshot, keys);
    if (Object.keys(local).length > 0) {
      if (!job.quiet) setErrors((e) => ({ ...e, ...local }));
      return { ok: false };
    }
    setSaveError(undefined);
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
      return { ok: true, campaign };
    } catch (failure) {
      const error = toApiError(failure);
      if (Object.keys(error.fields).length > 0) setErrors((e) => ({ ...e, ...error.fields }));
      else setSaveError(`Could not save the draft: ${error.message}`);
      return { ok: false };
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
        const outcome = await send(job).catch((): SaveResult => ({ ok: false }));
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
    if (loaded.status === "error") return <LoadError what="the campaign" message={loaded.error.message} onRetry={loaded.reload} />;
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
        return;
      }
      const { ok } = await save(STEPS[step]?.keys ?? []);
      await drain();
      // Going back never waits on a problem; going on does.
      if (!ok && next > step) return;
    }
    setStepMoved(true);
    setStep(next);
    window.scrollTo(0, 0);
  };

  const start = async (confirmAutoApprove: boolean) => {
    if (campaignId === null) return;
    setStarting(true);
    setStartError(undefined);
    const { ok } = await save(ALL_KEYS);
    await drain();
    const stop = (message: string) => {
      setStarting(false);
      setConfirmAuto(false);
      setStartError(message);
    };
    if (!ok) {
      stop("Some answers could not be saved. They are marked below.");
      return;
    }
    // Start only what the review shows: the app's copy after the last save must hold exactly these values.
    const shown = formNow.current;
    const kept = queue.current.lastSaved;
    const differ = shown === null || kept === null ? CHECKED_KEYS : keptDifferently(shown, kept);
    if (differ.length > 0) {
      const labels = [...new Set(differ.map((key) => FIELD_LABEL[key]))].join(", ");
      stop(`The campaign was not started: the app's copy of the draft differs from this page (${labels}). Press Start again to save this page and check once more.`);
      return;
    }
    try {
      await startCampaign(campaignId, confirmAutoApprove ? { confirmAutoApprove: true } : {});
      refresh();
      navigate(`/campaigns/${campaignId}`);
    } catch (failure) {
      const error = toApiError(failure);
      setErrors(error.fields);
      setStartError(Object.keys(error.fields).length > 0 ? "The campaign cannot start yet. Fix what is marked below, then press Start again." : error.message);
      setConfirmAuto(false);
    } finally {
      setStarting(false);
    }
  };

  const stepsWithProblems = new Set(Object.keys(errors).map(stepOf));
  const created = campaignId !== null;

  return (
    <>
      <PageHeader
        title="New campaign"
        aside={saving ? "Saving…" : savedAt !== null ? `Draft saved at ${formatClock(savedAt.toISOString(), timeZone)}` : created ? "Draft" : undefined}
      />
      <div className="grid gap-section lg:grid-cols-[13rem_minmax(0,1fr)]">
        <StepStrip step={step} furthest={furthest} problems={stepsWithProblems} created={created} onGo={(index) => void goTo(index)} />

        <div className="min-w-0">
          <ActionError message={saveError} className="mb-group" />
          <div key={step} className={stepMoved ? "animate-appear" : undefined}>
            {step === 0 && <NameStep form={form} set={set} errors={errors} onEnter={() => void goTo(1)} />}
            {step === 1 && <SourceStep form={form} set={set} errors={errors} />}
            {step === 2 && <WhoFitsStep form={form} set={set} errors={errors} />}
            {step === 3 && <ApprovalStep form={form} set={set} errors={errors} />}
            {step === 4 && campaignId !== null && (
              <StepFrame title="Messages" lead="Write what each person receives. Every word is yours; the variables fill in each person's details.">
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
                onClick={() => (form.autoApprove ? setConfirmAuto(true) : void start(false))}
              >
                {starting && <span className="loading loading-spinner loading-sm" />}
                Start the campaign
              </button>
            )}
            {step === REVIEW && (
              <p className="text-sm text-muted">Starting begins finding people. Nobody is invited before you approve them{form.autoApprove ? ", unless auto-approve is on" : ""}.</p>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmAuto}
        title="Start with auto-approve on?"
        confirmLabel="Start with auto-approve"
        tone="error"
        busy={starting}
        onConfirm={() => void start(true)}
        onCancel={() => setConfirmAuto(false)}
      >
        <p>
          Everyone who scores {form.scoreThreshold} or more will be invited and messaged without your review. You will not see them in the approval
          queue first.
        </p>
        <p className="text-base-content">To review each person yourself, cancel and turn auto-approve off in the Approval step.</p>
      </ConfirmDialog>
    </>
  );
}

// ------------------------------------------------------------ steps

interface StepProps {
  readonly form: CampaignForm;
  readonly set: SetField;
  readonly errors: FieldErrors;
}

function StepFrame({ title, lead, children }: { readonly title: string; readonly lead: string; readonly children: ReactNode }) {
  return (
    <section aria-labelledby="step-title">
      <h2 id="step-title" className="text-xl font-semibold">
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
            ["recommendations", "LinkedIn's recommendations", "The people LinkedIn suggests to you on its My Network page."],
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
          <p className="text-sm text-muted">
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
                      {...errorProps(urlId, serverError)}
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
          {...errorProps(countId, errors["targetProspectCount"])}
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
      <div className="mt-1 max-w-3xl text-sm text-muted">
        <p>Write who you want to reach: their role or whether they own the business, the industries, the places and the company size.</p>
        <p>Then write the signs of a good fit, and who to leave out.</p>
      </div>
      <textarea
        id={briefId}
        rows={14}
        className={`textarea mt-2 w-full max-w-3xl bg-base-100 text-base ${errors["scoringBrief"] === undefined ? "" : "textarea-error"}`}
        value={form.scoringBrief}
        onChange={(event) => set("scoringBrief", event.target.value)}
        {...errorProps(briefId, errors["scoringBrief"])}
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
      {...errorProps(id, errors[key])}
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
            onChange={(on) => set("autoApprove", on)}
            hint={form.autoApprove ? undefined : "Off: you approve each person before the app invites them."}
          />
          {form.autoApprove && (
            <Notice tone="note" role="alert" className="mt-3 text-sm">
              With auto-approve on, the app invites and messages everyone who reaches the score threshold without your review. You will not see
              them in the approval queue first.
            </Notice>
          )}
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
  readonly startError: string | undefined;
  readonly onChange: (step: number) => void;
}) {
  const urls = sentUrls(form.sourceUrls);
  const problems = (step: number) =>
    Object.entries(errors)
      .filter(([path]) => stepOf(path) === step)
      .map(([path, message]) => {
        const [key = "", index] = path.split(".");
        const label = key === "sourceUrls" && index !== undefined ? "Search address" : (Object.entries(FIELD_LABEL).find(([name]) => name === key)?.[1] ?? key);
        return { path, text: `${label}${index === undefined ? "" : ` ${Number(index) + 1}`}: ${message}` };
      });
  const text = (value: string, empty: string) => (value.trim() === "" ? <span className="text-muted">{empty}</span> : <span className="whitespace-pre-line">{value}</span>);

  const sections: readonly { readonly step: number; readonly rows: readonly (readonly [string, ReactNode])[] }[] = [
    { step: 0, rows: [["Name", text(form.name, "No name yet")]] },
    {
      step: 1,
      rows: [
        ["Source", form.discoverySource === "search" ? "People searches" : "LinkedIn's recommendations"],
        ...(form.discoverySource === "search"
          ? [["Searches", urls.length === 0 ? <span className="text-muted">None yet</span> : <ul className="break-all">{urls.map((u) => <li key={u}>{u}</li>)}</ul>] as const]
          : []),
        ["People to find", form.targetProspectCount.trim() === "" ? "No limit" : form.targetProspectCount],
      ],
    },
    { step: 2, rows: [["Who fits", text(form.scoringBrief, "Not written yet")]] },
    {
      step: 3,
      rows: [
        ["Batch size", form.batchSize],
        ["Score threshold", form.scoreThreshold],
        ["Open-profile threshold", form.openProfileThreshold],
        ["Auto-approve", form.autoApprove ? <span className="font-medium">On: people are invited without your review</span> : "Off: you approve each person"],
      ],
    },
    {
      step: 4,
      rows: [
        ["Invite note", text(form.inviteNote, "No note")],
        ["First message", text(form.firstMessage, "Not written yet")],
        ["Follow-up", text(form.followUp, "No follow-up")],
        ["AI-written line", form.aiPersonalise ? "On" : "Off"],
      ],
    },
    {
      step: 5,
      rows: [
        ["Before the first message", `${form.acceptToMessageMinHours} to ${form.acceptToMessageMaxHours} hours after they accept`],
        ["Before the follow-up", `${form.followUpDelayMinHours} to ${form.followUpDelayMaxHours} hours after the first message`],
        ["Counting days", POLICY_WORDS[form.delayPolicy]],
        ["Withdraw an unaccepted invite after", `${form.withdrawAfterDays} days`],
      ],
    },
  ];

  return (
    <section aria-labelledby="step-title">
      <h2 id="step-title" className="text-xl font-semibold">
        Review and start
      </h2>
      <p className="mt-1 max-w-2xl text-base-content">Check everything once more. The app checks it too when you press Start.</p>
      <ActionError message={startError} className="mt-block" testId="start-error" />
      <div className="mt-block divide-y divide-base-300 rounded-box border border-base-300">
        {sections.map(({ step, rows }) => {
          const list = problems(step);
          return (
            <div key={step} className="px-4 py-4" data-testid={`review-step-${step + 1}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 font-semibold">
                  {list.length === 0 ? <IconCheck className="size-4 text-primary" /> : <span className="status status-error" aria-hidden="true" />}
                  {STEPS[step]?.title}
                </h3>
                <button type="button" className="link inline-flex min-h-6 shrink-0 items-center text-sm link-hover max-lg:min-h-11" onClick={() => onChange(step)}>
                  Change<span className="sr-only"> {STEPS[step]?.title}</span>
                </button>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[13rem_minmax(0,1fr)]">
                {rows.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="min-w-0 wrap-break-word">{value}</dd>
                  </div>
                ))}
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
