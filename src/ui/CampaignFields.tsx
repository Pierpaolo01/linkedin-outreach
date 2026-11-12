import { useId, useRef, useState, type ReactNode } from "react";
import { previewCampaign } from "./api";
import type { PreviewText } from "./apiSchemas";
import { INVITE_NOTE_MAX, VARIABLES, type CampaignForm, type FieldErrors, type SetField } from "./campaignForm";
import { FieldError, LoadError, Notice, SECONDARY_BUTTON, SwitchRow, useDebounced } from "./formParts";
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
      aria-invalid={errors[key] !== undefined}
    />
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-w-0 flex-col gap-6">
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
            <span className={`nums text-sm ${noteLength > INVITE_NOTE_MAX ? "font-medium text-error" : "text-muted"}`} data-testid="note-count">
              {noteLength} / {INVITE_NOTE_MAX}
            </span>
          </div>
          <p className="text-sm text-muted">
            Sent with the invite. Leave it empty to invite without a note. LinkedIn allows {INVITE_NOTE_MAX} characters once the variables are filled
            in; the preview shows the real length.
          </p>
          <div className="mt-1.5">{textBox("inviteNote", 3, "Your invite note")}</div>
          <FieldError message={errors["inviteNote"]} />
        </div>

        <div>
          <label htmlFor={ids.firstMessage} className="font-medium">
            First message
          </label>
          <p className="text-sm text-muted">Sent after they accept your invite.</p>
          <div className="mt-1.5">{textBox("firstMessage", 6, "Your first message")}</div>
          <FieldError message={errors["firstMessage"]} />
        </div>

        <div>
          <label htmlFor={ids.followUp} className="font-medium">
            Follow-up <span className="font-normal text-muted">(optional)</span>
          </label>
          <p className="text-sm text-muted">Sent once if they have not replied to the first message. Leave it empty to send no follow-up.</p>
          <div className="mt-1.5">{textBox("followUp", 4, "Your follow-up")}</div>
          <FieldError message={errors["followUp"]} />
        </div>

        <div className="flex flex-col gap-3 rounded-box border border-base-300 px-4 py-4">
          <SwitchRow
            id={ids.personalise}
            label="Let the AI write one line for each person"
            hint="The line goes where you put the AI-written line variable, based only on what their profile says."
            checked={form.aiPersonalise}
            onChange={(on) => set("aiPersonalise", on)}
          />
          <FieldError message={errors["aiPersonalise"]} />
          {form.aiPersonalise && (
            <div>
              <label htmlFor={ids.instructions} className="text-sm font-medium">
                Your instructions for the AI line
              </label>
              <textarea
                id={ids.instructions}
                rows={3}
                className="textarea mt-1 w-full bg-base-100"
                value={form.personalisationInstructions}
                placeholder="What the line should be about, and what to avoid"
                onChange={(event) => set("personalisationInstructions", event.target.value)}
              />
              <FieldError message={errors["personalisationInstructions"]} />
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
  // Loads when the texts have stopped changing; the call reads the newest values.
  const loaded = useLoad(() => previewCampaign(campaignId, { inviteNote, firstMessage, followUp, aiPersonalise }), `${campaignId}|${settled}`, {
    keepPrevious: true,
  });

  return (
    <aside aria-label="Preview" className="min-w-0 lg:sticky lg:top-6 lg:self-start" data-testid="preview">
      <h3 className="font-semibold">Preview</h3>
      {loaded.status === "error" && loaded.data === undefined ? (
        <LoadError what="the preview" message={loaded.error.message} onRetry={loaded.reload} className="mt-2 text-sm" />
      ) : loaded.data === undefined ? (
        <div className="skeleton mt-2 h-40 w-full" />
      ) : (
        <>
          <p className="text-sm text-muted">
            {loaded.data.samples === "invented"
              ? "Filled in for an invented person until the campaign finds real people."
              : "Filled in for the first people this campaign found, exactly as they would receive it."}
          </p>
          <ul className="mt-3 flex flex-col gap-4">
            {loaded.data.items.map((item) => (
              <li key={item.prospectId ?? "sample"} className="flex flex-col gap-2 border-l-2 border-base-300 pl-3 text-sm">
                <p className="font-semibold">{item.fullName}</p>
                <PreviewLine label="Invite note" text={item.inviteNote} none="No note: the invite goes without one." />
                <PreviewLine label="First message" text={item.firstMessage} none="" />
                <PreviewLine label="Follow-up" text={item.followUp} none="No follow-up." />
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

function PreviewLine({ label, text, none }: { readonly label: string; readonly text: PreviewText | null; readonly none: string }) {
  let body: ReactNode;
  if (text === null) body = <p className="text-muted">{none}</p>;
  else if (text.ok) {
    body = (
      <>
        <p className="whitespace-pre-line">{text.text}</p>
        {label === "Invite note" && <p className="nums text-caption text-muted">{text.length} characters</p>}
      </>
    );
  } else if (text.problem === "empty") body = <p className="text-muted">Nothing written yet.</p>;
  else body = <Notice tone="waits">{text.message}</Notice>;
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
    <div className="flex max-w-2xl flex-col gap-6">
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
        <div className="mt-2 flex flex-col gap-2" id={ids.policy}>
          {(
            [
              ["calendar", "Every day counts, weekends too"],
              ["working_days", "Only working days count (the days set in Settings)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2.5">
              <input
                type="radio"
                name={ids.policy}
                className="radio radio-sm radio-primary"
                checked={form.delayPolicy === value}
                onChange={() => set("delayPolicy", value)}
              />
              {label}
            </label>
          ))}
        </div>
        <FieldError message={errors["delayPolicy"]} />
      </fieldset>

      <div>
        <label htmlFor={ids.withdraw} className="font-medium">
          Withdraw unanswered invites
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span>Withdraw an invite nobody accepted after</span>
          <input
            id={ids.withdraw}
            inputMode="numeric"
            className={`input input-sm w-20 bg-base-100 nums ${errors["withdrawAfterDays"] === undefined ? "" : "input-error"}`}
            value={form.withdrawAfterDays}
            onChange={(event) => set("withdrawAfterDays", event.target.value)}
          />
          <span>days.</span>
        </div>
        <FieldError message={errors["withdrawAfterDays"]} />
      </div>

      <Notice tone="note" className="text-sm">
        The app picks a random moment inside each range, and only acts inside your working hours. How many invites and messages go out each day is
        set in{" "}
        <Link to="/settings" className="link">
          Settings
        </Link>
        ; those limits are shared by all campaigns.
      </Notice>
    </div>
  );
}

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
  const box = (key: HourKey, value: string, label: string) => (
    <input
      inputMode="numeric"
      aria-label={`${props.legend}: ${label}`}
      className={`input input-sm w-20 bg-base-100 nums ${props.errors[key] === undefined ? "" : "input-error"}`}
      value={value}
      onChange={(event) => props.set(key, event.target.value)}
    />
  );
  return (
    <fieldset>
      <legend className="font-medium">{props.legend}</legend>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span>{props.lead}</span>
        {box(minKey, minValue, "shortest wait in hours")}
        <span>and</span>
        {box(maxKey, maxValue, "longest wait in hours")}
        <span>hours.</span>
      </div>
      {props.note !== undefined && <p className="mt-1 text-sm text-muted">{props.note}</p>}
      <FieldError message={error} />
    </fieldset>
  );
}
