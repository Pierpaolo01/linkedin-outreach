import { useId, useRef, useState, type ReactNode } from "react";
import { previewCampaign } from "./api";
import type { CampaignPreview, PreviewText } from "./apiSchemas";
import { INVITE_NOTE_MAX, VARIABLES, type CampaignForm, type FieldErrors, type SetField } from "./campaignForm";
import { joinWords, NBSP, withStop } from "./format";
import { describedByError, errorProps, FieldError, FilledText, hintIdOf, LoadError, Notice, SECONDARY_BUTTON, SwitchRow, useDebounced } from "./formParts";
import { Link } from "./router";
import { useLoad } from "./useLoad";

/** The messages and timings parts of a campaign form, shared by the wizard and the live-edit form. */

type TextKey = "inviteNote" | "firstMessage" | "followUp";
const TEXT_NAME: Readonly<Record<TextKey, string>> = { inviteNote: "invite note", firstMessage: "first message", followUp: "follow-up" };

export function MessageFields({
  campaignId,
  form,
  set,
  errors,
}: {
  readonly campaignId: number;
  readonly form: CampaignForm;
  readonly set: SetField;
  readonly errors: FieldErrors;
}) {
  const boxes = useRef(new Map<TextKey, HTMLTextAreaElement>());
  const [target, setTarget] = useState<TextKey>("firstMessage");
  const ids = { inviteNote: useId(), firstMessage: useId(), followUp: useId(), instructions: useId(), personalise: useId() };

  const insert = (variable: string) => {
    const box = boxes.current.get(target);
    const token = `{{${variable}}}`;
    const text = form[target];
    const start = box?.selectionStart ?? text.length;
    const end = box?.selectionEnd ?? text.length;
    set(target, text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      if (box === undefined) return;
      box.focus();
      box.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const register = (key: TextKey) => (element: HTMLTextAreaElement | null) => {
    if (element === null) boxes.current.delete(key);
    else boxes.current.set(key, element);
  };

  const noteLength = form.inviteNote.length;
  const variables = VARIABLES.filter((v) => v.name !== "ai_line" || form.aiPersonalise);

  const textBox = (key: TextKey, rows: number, placeholder: string) => (
    <textarea
      id={ids[key]}
      ref={register(key)}
      rows={rows}
      className={`textarea w-full bg-base-100 text-base ${errors[key] === undefined ? "" : "textarea-error"}`}
      value={form[key]}
      placeholder={placeholder}
      onFocus={() => setTarget(key)}
      onChange={(event) => set(key, event.target.value)}
      {...errorProps(ids[key], errors[key], { hint: hintIdOf(ids[key]) })}
    />
  );

  return (
    <div className="@container">
      <div className="grid gap-section @preview:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-block">
          <div className="rounded-box bg-base-200 px-4 py-3">
            <p className="text-sm">
              Add a detail that changes for each person. It goes into the <span className="font-medium">{TEXT_NAME[target]}</span>, where your cursor is.
            </p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Variables">
              {variables.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  className={`${SECONDARY_BUTTON} btn-xs font-normal`}
                  aria-label={`Insert ${v.label}`}
                  title={`Adds {{${v.name}}}`}
                  // Keep the cursor where it is in the text box.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insert(v.name)}
                >
                  {v.label}
                  <span className="text-muted">{`{{${v.name}}}`}</span>
                </button>
              ))}
            </div>
          </div>
  
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={ids.inviteNote} className="font-medium">
                Invite note <span className="font-normal text-muted">(optional)</span>
              </label>
              {/* The template's own length; the limit is for the filled-in text, which the preview counts. Red past the limit, which a save refuses too. */}
              <span className={`nums text-sm ${noteLength > INVITE_NOTE_MAX ? "font-medium text-error" : "text-muted"}`} data-testid="note-count">
                Template: {noteLength}{NBSP}characters
              </span>
            </div>
            <p id={hintIdOf(ids.inviteNote)} className="text-sm text-muted">
              Sent with the invite. Leave it empty to invite without a note. LinkedIn allows {INVITE_NOTE_MAX}{NBSP}characters once the variables are filled
              in; the preview shows the real length.
            </p>
            <div className="mt-1.5">{textBox("inviteNote", 3, "Your invite note")}</div>
            <FieldError controlId={ids.inviteNote} message={errors["inviteNote"]} />
          </div>
  
          <div>
            <label htmlFor={ids.firstMessage} className="font-medium">
              First message
            </label>
            <p id={hintIdOf(ids.firstMessage)} className="text-sm text-muted">
              Sent after they accept your invite.
            </p>
            <div className="mt-1.5">{textBox("firstMessage", 6, "Your first message")}</div>
            <FieldError controlId={ids.firstMessage} message={errors["firstMessage"]} />
          </div>
  
          <div>
            <label htmlFor={ids.followUp} className="font-medium">
              Follow-up <span className="font-normal text-muted">(optional)</span>
            </label>
            <p id={hintIdOf(ids.followUp)} className="text-sm text-muted">
              Sent once if they have not replied to the first message. Leave it empty to send no follow-up.
            </p>
            <div className="mt-1.5">{textBox("followUp", 4, "Your follow-up")}</div>
            <FieldError controlId={ids.followUp} message={errors["followUp"]} />
          </div>
  
          <div className="flex flex-col gap-3 rounded-box border border-base-300 px-4 py-4">
            <SwitchRow
              id={ids.personalise}
              label="Let the AI write one line for each person"
              hint={
                <>
                  The line goes where you put <code className="font-mono">{"{{ai_line}}"}</code> in a text, and is based only on what their profile says.
                </>
              }
              checked={form.aiPersonalise}
              error={errors["aiPersonalise"]}
              onChange={(on) => set("aiPersonalise", on)}
            />
            <FieldError controlId={ids.personalise} message={errors["aiPersonalise"]} />
            {form.aiPersonalise && (
              <div>
                <label htmlFor={ids.instructions} className="text-sm font-medium">
                  Your instructions for the AI line
                </label>
                <textarea
                  id={ids.instructions}
                  rows={3}
                  className={`textarea mt-1 w-full bg-base-100 ${errors["personalisationInstructions"] === undefined ? "" : "textarea-error"}`}
                  value={form.personalisationInstructions}
                  placeholder="What the line should be about, and what to avoid"
                  onChange={(event) => set("personalisationInstructions", event.target.value)}
                  {...errorProps(ids.instructions, errors["personalisationInstructions"])}
                />
                <FieldError controlId={ids.instructions} message={errors["personalisationInstructions"]} />
              </div>
            )}
          </div>
        </div>
  
        <TemplatePreview
          campaignId={campaignId}
          inviteNote={form.inviteNote}
          firstMessage={form.firstMessage}
          followUp={form.followUp}
          aiPersonalise={form.aiPersonalise}
        />
      </div>
    </div>
  );
}

/** The texts filled in for real (or invented) people, as they would be sent, or the exact problem. */
function TemplatePreview(props: {
  readonly campaignId: number;
  readonly inviteNote: string;
  readonly firstMessage: string;
  readonly followUp: string;
  readonly aiPersonalise: boolean;
}) {
  const { campaignId, inviteNote, firstMessage, followUp, aiPersonalise } = props;
  const settled = useDebounced(JSON.stringify([inviteNote, firstMessage, followUp, aiPersonalise]), 350);
  // Loads when the texts have stopped changing; the call reads the newest values, and keeps the templates it sent so
  // the filled-in values are set apart against the texts they were filled from, not newer ones still being typed.
  const loaded = useLoad(
    () =>
      previewCampaign(campaignId, { inviteNote, firstMessage, followUp, aiPersonalise }).then((preview) => ({
        ...preview,
        templates: { inviteNote, firstMessage, followUp },
      })),
    `${campaignId}|${settled}`,
    { keepPrevious: true },
  );
  const templates = loaded.data?.templates;
  const problems = loaded.data === undefined ? [] : templateProblems(loaded.data.items);

  return (
    <aside aria-label="Preview" className="min-w-0 @preview:sticky @preview:top-6 @preview:self-start" data-testid="preview">
      <h3 className="font-semibold">Preview</h3>
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the preview" error={loaded.error} onRetry={loaded.reload} className="mt-2 text-sm" />
      ) : loaded.data === undefined ? (
        <div className="skeleton mt-2 h-40 w-full" />
      ) : (
        <>
          <p className="text-sm text-muted">
            {loaded.data.samples === "invented"
              ? "Filled in for an invented person until the campaign finds real people."
              : "Filled in for the first people this campaign found, exactly as they would receive it."}
          </p>
          {/* A mistake in a template is the same for everyone: said once, in the error tone the field shows it in. */}
          {problems.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-error" data-testid="preview-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <ul className="mt-3 flex flex-col gap-4">
            {loaded.data.items.map((item) => (
              <li key={item.prospectId ?? "sample"} className="flex flex-col gap-2 border-l-2 border-base-300 pl-3 text-sm">
                <p className="font-semibold">{item.fullName}</p>
                <PreviewLine label={TEXT_LABEL.inviteNote} text={item.inviteNote} template={templates?.inviteNote} none="No note: the invite goes without one." />
                <PreviewLine label={TEXT_LABEL.firstMessage} text={item.firstMessage} template={templates?.firstMessage} none="" />
                <PreviewLine label={TEXT_LABEL.followUp} text={item.followUp} template={templates?.followUp} none="No follow-up" />
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

const TEXT_LABEL: Readonly<Record<TextKey, string>> = { inviteNote: "Invite note", firstMessage: "First message", followUp: "Follow-up" };
const TEXT_KEYS = ["inviteNote", "firstMessage", "followUp"] as const satisfies readonly TextKey[];

/** A problem with the template itself, the same for everyone (or, for a text too long, for whoever it is too long for). */
const TEMPLATE_PROBLEMS: ReadonlySet<string> = new Set(["unknown_variable", "malformed", "too_long"]);
const isTemplateProblem = (text: PreviewText | null) => text !== null && !text.ok && TEMPLATE_PROBLEMS.has(text.problem);

/**
 * The template mistakes in a preview, once each, as sentences naming the text: "Follow-up: {{oops}} is not a
 * variable." A text too long is said once with the people it is too long for.
 */
function templateProblems(items: CampaignPreview["items"]): string[] {
  return TEXT_KEYS.flatMap((key) => {
    const failed = items.flatMap((item) => {
      const text = item[key];
      return text !== null && !text.ok && TEMPLATE_PROBLEMS.has(text.problem) ? [{ name: item.fullName, text }] : [];
    });
    const first = failed[0];
    if (first === undefined) return [];
    if (first.text.problem === "too_long") {
      return [withStop(`${TEXT_LABEL[key]}: longer than ${INVITE_NOTE_MAX}${NBSP}characters for ${joinWords(failed.map((f) => f.name))}`)];
    }
    return [withStop(`${TEXT_LABEL[key]}: ${first.text.message}`)];
  });
}

function PreviewLine(props: { readonly label: string; readonly text: PreviewText | null; readonly template: string | undefined; readonly none: string }) {
  const { label, text, template, none } = props;
  // Said once above the people (`templateProblems`), not again for each of them.
  if (isTemplateProblem(text)) return null;
  let body: ReactNode;
  if (text === null) body = <p className="text-muted">{none}</p>;
  else if (text.ok) {
    body = (
      <>
        <p className="whitespace-pre-line" data-testid="sent-text">
          <FilledText text={text.text} template={template} />
        </p>
        {label === "Invite note" && (
          <p className="nums text-caption text-muted">
            {text.length} of {INVITE_NOTE_MAX}{NBSP}characters
          </p>
        )}
      </>
    );
  } else if (text.problem === "empty") body = <p className="text-muted">Nothing written yet.</p>;
  // This person's text cannot be written yet (a value they lack): plain information, not amber, which means "waits for you".
  else body = <Notice tone="note">{withStop(text.message)}</Notice>;
  return (
    <div>
      <p className="text-caption text-muted">{label}</p>
      {body}
    </div>
  );
}

// ------------------------------------------------------------ timings

export function TimingFields({ form, set, errors }: { readonly form: CampaignForm; readonly set: SetField; readonly errors: FieldErrors }) {
  const ids = { withdraw: useId(), policy: useId() };
  return (
    <div className="flex max-w-2xl flex-col gap-block">
      <HourRange
        legend="Before the first message"
        lead="After someone accepts your invite, wait between"
        min={["acceptToMessageMinHours", form.acceptToMessageMinHours]}
        max={["acceptToMessageMaxHours", form.acceptToMessageMaxHours]}
        set={set}
        errors={errors}
      />
      <HourRange
        legend="Before the follow-up"
        lead="After the first message, if they have not replied, wait between"
        min={["followUpDelayMinHours", form.followUpDelayMinHours]}
        max={["followUpDelayMaxHours", form.followUpDelayMaxHours]}
        set={set}
        errors={errors}
        note={form.followUp.trim() === "" ? "This campaign has no follow-up, so this wait is not used." : undefined}
      />

      <fieldset>
        <legend className="font-medium">How the waits count days</legend>
        <div className="mt-1 flex flex-col" id={ids.policy}>
          {(
            [
              ["calendar", "Every day counts, weekends too"],
              ["working_days", "Only working days count (the days set in Settings)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2.5 py-1 max-lg:py-2.5">
              <input
                type="radio"
                name={ids.policy}
                className="radio radio-sm radio-primary"
                checked={form.delayPolicy === value}
                onChange={() => set("delayPolicy", value)}
                {...describedByError(ids.policy, errors["delayPolicy"])}
              />
              {label}
            </label>
          ))}
        </div>
        <FieldError controlId={ids.policy} message={errors["delayPolicy"]} />
      </fieldset>

      <div>
        <label htmlFor={ids.withdraw} className="font-medium">
          Withdraw unanswered invites
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span>Withdraw an invite nobody accepted after</span>
          {/* The unit stays with its box: never "[21]" at a line's end and "days." alone on the next. */}
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <input
              id={ids.withdraw}
              inputMode="numeric"
              className={`input input-sm w-20 bg-base-100 nums ${errors["withdrawAfterDays"] === undefined ? "" : "input-error"}`}
              value={form.withdrawAfterDays}
              onChange={(event) => set("withdrawAfterDays", event.target.value)}
              {...errorProps(ids.withdraw, errors["withdrawAfterDays"])}
            />
            <span>days.</span>
          </span>
        </div>
        <FieldError controlId={ids.withdraw} message={errors["withdrawAfterDays"]} />
      </div>

      <Notice tone="note" className="text-sm">
        The app picks a random moment inside each range, and only acts inside your working window. How many invites and messages go out each day is
        set in{" "}
        <Link to="/settings" className="link">
          Settings
        </Link>
        ; those budgets are shared by all campaigns.
      </Notice>
    </div>
  );
}

/** The app's rule on a wait's two boxes (`src/campaigns/rules.ts`), which it reports on the shortest. */
const PAIR_RULE = /^The shortest wait must not be longer than the longest/;

type HourKey = "acceptToMessageMinHours" | "acceptToMessageMaxHours" | "followUpDelayMinHours" | "followUpDelayMaxHours";

function HourRange(props: {
  readonly legend: string;
  readonly lead: string;
  readonly min: readonly [HourKey, string];
  readonly max: readonly [HourKey, string];
  readonly set: SetField;
  readonly errors: FieldErrors;
  readonly note?: string | undefined;
}) {
  const [minKey, minValue] = props.min;
  const [maxKey, maxValue] = props.max;
  const error = props.errors[minKey] ?? props.errors[maxKey];
  // The app's rule on the pair (the shortest above the longest) arrives on the shortest; it is about both boxes.
  const pairError = props.errors[minKey] !== undefined && PAIR_RULE.test(props.errors[minKey]);
  const groupId = useId();
  const box = (key: HourKey, value: string, label: string) => {
    // A box is marked when it is wrong itself, or when the pair is: then both are, and the first takes the focus.
    const invalid = props.errors[key] !== undefined || pairError;
    return (
      <input
        inputMode="numeric"
        aria-label={`${props.legend}: ${label}`}
        className={`input input-sm w-20 bg-base-100 nums ${invalid ? "input-error" : ""}`}
        value={value}
        onChange={(event) => {
          props.set(key, event.target.value);
          // A change to either box answers the rule on the pair, so the other box is no longer marked for it.
          if (pairError && key !== minKey) props.set(minKey, minValue);
        }}
        aria-invalid={invalid || undefined}
        {...describedByError(groupId, invalid ? error : undefined, { hint: props.note === undefined ? undefined : hintIdOf(groupId) })}
      />
    );
  };
  return (
    <fieldset>
      <legend className="font-medium">{props.legend}</legend>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span>{props.lead}</span>
        {box(minKey, minValue, "shortest wait in hours")}
        {/* "and [48] hours." is one piece, so the unit never starts a line alone, as in Settings' ranges. */}
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <span>and</span>
          {box(maxKey, maxValue, "longest wait in hours")}
          <span>hours.</span>
        </span>
      </div>
      {props.note !== undefined && (
        <p id={hintIdOf(groupId)} className="mt-1 text-sm text-muted">
          {props.note}
        </p>
      )}
      <FieldError controlId={groupId} message={error} />
    </fieldset>
  );
}
