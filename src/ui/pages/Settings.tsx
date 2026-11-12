import { useEffect, useId, useState, type ReactNode } from "react";
import { backUpNow, getOps, prospectsCsvUrl, testAi, toApiError, updateSettings } from "../api";
import { AI_PROVIDERS, type AiProvider, type AiTest, type BackupResult, type Ops, type Settings as SettingsData, type SettingsPatch } from "../apiSchemas";
import { useAppData } from "../appData";
import { asSentence, formatWhen } from "../format";
import { ActionError, FieldError, LoadError, Notice, SECONDARY_BUTTON, SwitchRow } from "../formParts";
import { sessionView } from "../shell/sessionView";
import { useRecheck } from "../shell/useRecheck";
import { useLoad, type Loaded } from "../useLoad";
import { formatBytes, formatDate } from "../words";
import { PageHeader } from "./PageHeader";

// ------------------------------------------------------------ the form

const NUMBER_GROUPS = {
  actionGapSeconds: ["min", "max"],
  breaks: ["everyActionsMin", "everyActionsMax", "minutesMin", "minutesMax"],
  limits: ["invitesPerDay", "invitesPerWeek", "messagesPerDay", "profileViewsPerDay", "discoveryPagesPerDay", "withdrawalsPerDay"],
  warmUp: ["invitesStartPerDay", "invitesIncreasePerDay"],
} as const satisfies { readonly [G in keyof SettingsData]?: readonly (keyof SettingsData[G])[] };
type NumberGroup = keyof typeof NUMBER_GROUPS;
const GROUP_NAMES = ["actionGapSeconds", "breaks", "limits", "warmUp"] as const satisfies readonly NumberGroup[];

/** Numbers as typed, by the path the app names them with (`limits.invitesPerDay`). */
type Numbers = Readonly<Record<string, string>>;

interface Form {
  readonly timeZone: string;
  readonly workingDays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly numbers: Numbers;
  readonly warmUpEnabled: boolean;
  readonly provider: AiProvider;
  readonly model: string;
  readonly keepAwake: boolean;
}

const COOLDOWN = "inviteLimitCooldownDays";

function toForm(s: SettingsData): Form {
  const numbers: Record<string, string> = { [COOLDOWN]: String(s.inviteLimitCooldownDays) };
  for (const group of GROUP_NAMES) {
    const values: Readonly<Record<string, number | boolean>> = s[group];
    for (const key of NUMBER_GROUPS[group]) numbers[`${group}.${key}`] = String(values[key]);
  }
  return {
    timeZone: s.timeZone,
    workingDays: s.workingDays,
    start: s.workingHours.start,
    end: s.workingHours.end,
    numbers,
    warmUpEnabled: s.warmUp.enabled,
    provider: s.ai.provider,
    model: s.ai.model,
    keepAwake: s.keepAwake,
  };
}

/** Only what changed, nested groups one field at a time, as the app takes it; or the numbers that are not numbers. */
function toPatch(form: Form, base: SettingsData): { readonly patch: SettingsPatch; readonly errors: Readonly<Record<string, string>> } {
  const errors: Record<string, string> = {};
  const was = toForm(base);
  const number = (path: string): number | undefined => {
    const text = (form.numbers[path] ?? "").trim();
    if (text === (was.numbers[path] ?? "")) return undefined;
    const n = Number(text);
    if (text === "" || !Number.isFinite(n)) {
      errors[path] = "Enter a number";
      return undefined;
    }
    return n;
  };
  const group = <G extends NumberGroup>(name: G): Partial<Record<(typeof NUMBER_GROUPS)[G][number], number>> | undefined => {
    const out: Partial<Record<string, number>> = {};
    for (const key of NUMBER_GROUPS[name]) {
      const n = number(`${name}.${key}`);
      if (n !== undefined) out[key] = n;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };

  const patch: { -readonly [K in keyof SettingsPatch]: SettingsPatch[K] } = {};
  if (form.timeZone.trim() !== base.timeZone) patch.timeZone = form.timeZone.trim();
  const days = [...form.workingDays].sort((a, b) => a - b);
  if (JSON.stringify(days) !== JSON.stringify([...base.workingDays].sort((a, b) => a - b))) patch.workingDays = days;
  if (form.start !== base.workingHours.start || form.end !== base.workingHours.end) {
    patch.workingHours = {
      ...(form.start === base.workingHours.start ? {} : { start: form.start }),
      ...(form.end === base.workingHours.end ? {} : { end: form.end }),
    };
  }
  const gap = group("actionGapSeconds");
  if (gap !== undefined) patch.actionGapSeconds = gap;
  const breaks = group("breaks");
  if (breaks !== undefined) patch.breaks = breaks;
  const limits = group("limits");
  if (limits !== undefined) patch.limits = limits;
  const warm = group("warmUp");
  if (warm !== undefined || form.warmUpEnabled !== base.warmUp.enabled) {
    patch.warmUp = { ...warm, ...(form.warmUpEnabled === base.warmUp.enabled ? {} : { enabled: form.warmUpEnabled }) };
  }
  const cooldown = number(COOLDOWN);
  if (cooldown !== undefined) patch.inviteLimitCooldownDays = cooldown;
  if (form.provider !== base.ai.provider || form.model.trim() !== base.ai.model) {
    patch.ai = {
      ...(form.provider === base.ai.provider ? {} : { provider: form.provider }),
      ...(form.model.trim() === base.ai.model ? {} : { model: form.model.trim() }),
    };
  }
  if (form.keepAwake !== base.keepAwake) patch.keepAwake = form.keepAwake;
  return { patch, errors };
}

/** The app's terse rule messages, in plain words. */
const RULE_WORDS: Readonly<Record<string, string>> = {
  "end must be after start": "The end must be after the start.",
  "min must not exceed max": "The first number must not be above the second.",
  "everyActionsMin must not exceed everyActionsMax": "The first number of actions must not be above the second.",
  "minutesMin must not exceed minutesMax": "The shortest break must not be longer than the longest.",
  "unknown time zone": "This is not a time zone the app knows. Choose one from the list.",
  "expected HH:MM, 24-hour": "Write the time as hours and minutes, 24-hour.",
  "days must not repeat": "Each day can be chosen once.",
};
const words = (message: string) => RULE_WORDS[message] ?? asSentence(message);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const PROVIDER_LABEL: Readonly<Record<AiProvider, string>> = {
  claude_cli: "Claude Code on this Mac (the claude command)",
  anthropic_api: "Anthropic API, with your API key",
};

// ------------------------------------------------------------ the page

export function Settings() {
  const { settings, settingsError, refreshSettings } = useAppData();
  if (settings === undefined) {
    return (
      <>
        <PageHeader title="Settings" />
        {settingsError === undefined ? (
          <div className="skeleton h-96 w-full" />
        ) : (
          <LoadError what="the settings" message={settingsError.message} onRetry={refreshSettings} />
        )}
      </>
    );
  }
  return <SettingsForm settings={settings} onSaved={refreshSettings} />;
}

function SettingsForm({ settings, onSaved }: { readonly settings: SettingsData; readonly onSaved: () => void }) {
  const [base, setBase] = useState(settings);
  const [form, setForm] = useState<Form>(() => toForm(settings));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly text: string } | undefined>(undefined);
  const ops = useLoad(getOps, "ops");
  const ids = { zone: useId(), start: useId(), end: useId(), model: useId(), provider: useId(), warm: useId(), awake: useId() };

  const pending = toPatch(form, base);
  const dirty = Object.keys(pending.patch).length > 0 || Object.keys(pending.errors).length > 0;
  const aiDirty = pending.patch.ai !== undefined;

  const change = (next: Partial<Form>, ...paths: string[]) => {
    setForm((f) => ({ ...f, ...next }));
    setResult(undefined);
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([path]) => !paths.some((p) => path === p || path.startsWith(`${p}.`) || p.startsWith(`${path}.`)))));
  };
  const setNumber = (path: string) => (value: string) => change({ numbers: { ...form.numbers, [path]: value } }, path);

  const save = () => {
    const built = toPatch(form, base);
    if (Object.keys(built.errors).length > 0) {
      setErrors(built.errors);
      setResult({ ok: false, text: "Some settings need attention. They are marked." });
      return;
    }
    setSaving(true);
    setResult(undefined);
    updateSettings(built.patch)
      .then((next) => {
        setBase(next);
        setForm(toForm(next));
        setErrors({});
        setResult({ ok: true, text: "Settings saved." });
        onSaved();
      })
      .catch((failure: unknown) => {
        const error = toApiError(failure);
        setErrors(Object.fromEntries(Object.entries(error.fields).map(([path, message]) => [path, words(message)])));
        setResult({ ok: false, text: Object.keys(error.fields).length > 0 ? "Nothing was saved: some settings are not valid. They are marked." : error.message });
      })
      .finally(() => setSaving(false));
  };

  const num = (path: string, label: string, width = "w-20") => (
    <input
      aria-label={label}
      inputMode="numeric"
      className={`input input-sm ${width} bg-base-100 nums ${errors[path] === undefined ? "" : "input-error"}`}
      value={form.numbers[path] ?? ""}
      onChange={(event) => setNumber(path)(event.target.value)}
    />
  );
  /** The first message for any of these paths (a range's check arrives on the group). */
  const errorOf = (...paths: string[]) => paths.map((p) => errors[p]).find((m) => m !== undefined);

  const timeZones = Intl.supportedValuesOf("timeZone");

  return (
    <>
      <PageHeader title="Settings" lead="These apply to the whole app and to every campaign." />

      <div className="flex max-w-3xl flex-col gap-section pb-4">
        <Group title="How the app works on LinkedIn">
          <LinkedInWindow />

          <Section title="Working hours" lead="The app acts on LinkedIn only on these days and between these times.">
            <div className="flex flex-col gap-block">
              <div>
                <label htmlFor={ids.zone} className="block font-medium">
                  Time zone
                </label>
                <input
                  id={ids.zone}
                  list={`${ids.zone}-list`}
                  className={`input mt-1.5 w-full max-w-sm bg-base-100 ${errors["timeZone"] === undefined ? "" : "input-error"}`}
                  value={form.timeZone}
                  onChange={(event) => change({ timeZone: event.target.value }, "timeZone")}
                />
                <datalist id={`${ids.zone}-list`}>
                  {timeZones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                <FieldError message={errors["timeZone"]} />
              </div>
              <fieldset className="min-w-0">
                <legend className="font-medium">Working days</legend>
                <div className="mt-1.5 grid max-w-md grid-cols-7 gap-1">
                  {DAYS.map((day, i) => {
                    const iso = i + 1;
                    const on = form.workingDays.includes(iso);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        className={`${on ? "btn btn-neutral" : SECONDARY_BUTTON} min-w-0 px-0`}
                        onClick={() => change({ workingDays: on ? form.workingDays.filter((d) => d !== iso) : [...form.workingDays, iso] }, "workingDays")}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
                <FieldError message={errorOf("workingDays")} />
              </fieldset>
              <fieldset>
                <legend className="font-medium">Hours</legend>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span>From</span>
                  <input
                    id={ids.start}
                    type="time"
                    aria-label="Start of the working day"
                    className={`input input-sm w-32 bg-base-100 nums ${errors["workingHours.start"] === undefined ? "" : "input-error"}`}
                    value={form.start}
                    onChange={(event) => change({ start: event.target.value }, "workingHours")}
                  />
                  <span>to</span>
                  <input
                    id={ids.end}
                    type="time"
                    aria-label="End of the working day"
                    className={`input input-sm w-32 bg-base-100 nums ${errors["workingHours.end"] === undefined && errors["workingHours"] === undefined ? "" : "input-error"}`}
                    value={form.end}
                    onChange={(event) => change({ end: event.target.value }, "workingHours")}
                  />
                </div>
                <FieldError message={errorOf("workingHours", "workingHours.start", "workingHours.end")} />
              </fieldset>
            </div>
          </Section>

          <Section title="Daily limits" lead="Shared by all campaigns. When a limit is reached, that kind of work waits for the next day by itself.">
            <Notice tone="note" className="mb-block text-sm">
              What you do by hand on LinkedIn also counts. LinkedIn sees one account, so the invites and messages you send yourself add to the
              app&rsquo;s, and the app cannot count them. If you also invite or message people yourself, lower these limits.
            </Notice>
            <div className="flex flex-col divide-y divide-base-300">
              <LimitRow control={num("limits.invitesPerDay", "Invites per day")} label="Invites per day" hint="Connection invites sent in a day." error={errorOf("limits.invitesPerDay")} />
              <LimitRow
                control={num("limits.invitesPerWeek", "Invites per week")}
                label="Invites per week"
                hint="A ceiling for the calendar week, so several full days do not add up to too many."
                error={errorOf("limits.invitesPerWeek")}
              />
              <LimitRow control={num("limits.messagesPerDay", "Messages per day")} label="Messages per day" hint="First messages and follow-ups together." error={errorOf("limits.messagesPerDay")} />
              <LimitRow
                control={num("limits.profileViewsPerDay", "Profile views per day")}
                label="Profile views per day"
                hint="Profiles the app opens to score people."
                error={errorOf("limits.profileViewsPerDay")}
              />
              <LimitRow
                control={num("limits.discoveryPagesPerDay", "Discovery pages per day")}
                label="Discovery pages per day"
                hint="Search and recommendation pages loaded to find people."
                error={errorOf("limits.discoveryPagesPerDay")}
              />
              <LimitRow
                control={num("limits.withdrawalsPerDay", "Withdrawals per day")}
                label="Withdrawals per day"
                hint="Old invites nobody accepted, withdrawn in a day."
                error={errorOf("limits.withdrawalsPerDay")}
              />
              <LimitRow
                control={num(COOLDOWN, "Days invites stay off")}
                label="Days invites stay off"
                hint="After LinkedIn says you have sent too many invites, the app sends none for this many days, even after you resume."
                error={errorOf(COOLDOWN)}
              />
            </div>
          </Section>

          <Section title="Warm-up and pace" lead="How quickly the app builds up, and how it spaces its actions so they look like a person at work.">
            <div className="flex flex-col gap-block">
              <div>
                <SwitchRow
                  id={ids.warm}
                  label="Warm-up"
                  checked={form.warmUpEnabled}
                  onChange={(on) => change({ warmUpEnabled: on }, "warmUp")}
                  hint="Starts with few invites a day and adds more each day until it reaches the daily limit."
                />
                {form.warmUpEnabled && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 pl-14 text-sm">
                    <span>Start at</span>
                    {num("warmUp.invitesStartPerDay", "Warm-up: invites on the first day")}
                    <span>invites a day and add</span>
                    {num("warmUp.invitesIncreasePerDay", "Warm-up: invites added each day")}
                    <span>each day.</span>
                  </div>
                )}
                <FieldError message={errorOf("warmUp", "warmUp.invitesStartPerDay", "warmUp.invitesIncreasePerDay")} />
              </div>
              <div>
                <p className="font-medium">Gap between actions</p>
                <p className="text-sm text-muted">A random wait between two actions on LinkedIn.</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <span>Between</span>
                  {num("actionGapSeconds.min", "Shortest gap in seconds")}
                  <span>and</span>
                  {num("actionGapSeconds.max", "Longest gap in seconds")}
                  <span>seconds.</span>
                </div>
                <FieldError message={errorOf("actionGapSeconds", "actionGapSeconds.min", "actionGapSeconds.max")} />
              </div>
              <div>
                <p className="font-medium">Breaks</p>
                <p className="text-sm text-muted">A longer pause now and then, as a person would take.</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <span>A break of</span>
                  {num("breaks.minutesMin", "Shortest break in minutes")}
                  <span>to</span>
                  {num("breaks.minutesMax", "Longest break in minutes")}
                  <span>minutes every</span>
                  {num("breaks.everyActionsMin", "Fewest actions between breaks")}
                  <span>to</span>
                  {num("breaks.everyActionsMax", "Most actions between breaks")}
                  <span>actions.</span>
                </div>
                <FieldError message={errorOf("breaks", "breaks.minutesMin", "breaks.minutesMax", "breaks.everyActionsMin", "breaks.everyActionsMax")} />
              </div>
            </div>
          </Section>
        </Group>

        <Group title="This Mac">
          <Section title="Keep the Mac awake" lead="A Mac that sleeps stops the app. This keeps it awake only when there is work to do.">
            <SwitchRow
              id={ids.awake}
              label="Keep the Mac awake while a campaign is working"
              checked={form.keepAwake}
              onChange={(on) => change({ keepAwake: on }, "keepAwake")}
              hint="Only inside your working hours, while a campaign is finding people or running. The screen can still turn off."
            />
            <p className="mt-2 text-sm text-base-content" data-testid="keep-awake-now">
              {ops.data === undefined ? "" : ops.data.keepAwake.active ? "Keeping the Mac awake right now." : "Not keeping the Mac awake right now."}
            </p>
          </Section>

          <Section title="AI" lead="The AI scores the people each campaign finds and, if you turn it on, writes the personal line.">
            <div className="flex flex-col gap-block">
              <div>
                <label htmlFor={ids.provider} className="block font-medium">
                  Which AI
                </label>
                <select
                  id={ids.provider}
                  className="select mt-1.5 w-full max-w-sm bg-base-100"
                  value={form.provider}
                  onChange={(event) => {
                    const provider = AI_PROVIDERS.find((p) => p === event.target.value);
                    if (provider !== undefined) change({ provider }, "ai");
                  }}
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
                <FieldError message={errorOf("ai", "ai.provider")} />
              </div>
              <div>
                <label htmlFor={ids.model} className="block font-medium">
                  Model
                </label>
                <p className="text-sm text-muted">Leave it empty to use the provider&rsquo;s default.</p>
                <input
                  id={ids.model}
                  className="input mt-1.5 w-full max-w-sm bg-base-100"
                  value={form.model}
                  onChange={(event) => change({ model: event.target.value }, "ai")}
                />
                <FieldError message={errorOf("ai.model")} />
              </div>
              <AiTestButton blocked={aiDirty} />
            </div>
          </Section>

          <Backups ops={ops} />
          <AutoStart ops={ops} />

          <Section title="Export" lead="Every prospect of every campaign, with stage, score, dates and the texts sent, for a spreadsheet.">
            <a href={prospectsCsvUrl()} className={`${SECONDARY_BUTTON} btn-sm`} download>
              Download all prospects (CSV)
            </a>
          </Section>
        </Group>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-base-300 bg-base-100 px-4 py-3 lg:-mx-10 lg:px-10">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving || !dirty} onClick={save}>
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save settings
        </button>
        {dirty && (
          <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={saving} onClick={() => {
              setForm(toForm(base));
              setErrors({});
              setResult(undefined);
            }}
          >
            Undo changes
          </button>
        )}
        <p role="status" className={`text-sm ${result === undefined ? "text-muted" : result.ok ? "text-primary" : "text-error"}`} data-testid="settings-result">
          {result?.text ?? (dirty ? "You have changes that are not saved." : "No changes to save.")}
        </p>
      </div>
    </>
  );
}

/** One of the two plain groups the settings fall into, over its cards. */
function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-group text-xl font-semibold">
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Section({ title, lead, children }: { readonly title: string; readonly lead: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-box border border-base-300 p-card">
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      <p className="mb-group text-sm text-muted">{lead}</p>
      {children}
    </section>
  );
}

function LimitRow({ control, label, hint, error }: { readonly control: ReactNode; readonly label: string; readonly hint: string; readonly error: string | undefined }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {control}
      {error !== undefined && (
        <div className="col-span-2">
          <FieldError message={error} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the LinkedIn window

/** The session of the app's own Chrome window: its state, when it was last checked, Re-check, and how to log in again. */
function LinkedInWindow() {
  const { home, timeZone } = useAppData();
  const recheck = useRecheck();
  const session = home?.session;
  const view = session === undefined ? undefined : sessionView(session);
  return (
    <Section title="LinkedIn window" lead="The app works on LinkedIn only in its own Chrome window, logged in to your account.">
      {session === undefined || view === undefined ? (
        <div className="skeleton h-12 w-full" />
      ) : (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-60">
            <p className="flex items-center gap-2 font-medium" data-testid="linkedin-window-state">
              <span className={`status ${view.light}`} aria-hidden="true" />
              {view.label}
            </p>
            <p className="text-sm text-muted" data-testid="linkedin-window-checked">
              {session.lastCheckedAt === null ? "Never checked." : `Last checked ${formatWhen(session.lastCheckedAt, timeZone, new Date())}.`}
            </p>
            {view.problem !== undefined && <p className="mt-1 text-sm">{view.problem}</p>}
          </div>
          <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={recheck.checking} onClick={recheck.run}>
            {recheck.checking && <span className="loading loading-spinner loading-xs" />}
            Re-check
          </button>
        </div>
      )}
      <ActionError message={recheck.error} className="mt-2" />
      <p className="mt-group text-sm text-base-content">
        If LinkedIn logs the app out, log in again in the app&rsquo;s own Chrome window, not in your usual browser, then press Re-check.
      </p>
    </Section>
  );
}

// ------------------------------------------------------------ the AI test

function AiTestButton({ blocked }: { readonly blocked: boolean }) {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [outcome, setOutcome] = useState<AiTest | { readonly failed: string } | undefined>(undefined);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const run = () => {
    setRunning(true);
    setSeconds(0);
    setOutcome(undefined);
    testAi()
      .then(setOutcome)
      .catch((failure: unknown) => setOutcome({ failed: toApiError(failure).message }))
      .finally(() => setRunning(false));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={running || blocked} onClick={run}>
          {running && <span className="loading loading-spinner loading-xs" />}
          Test
        </button>
        {running && (
          <p role="status" className="nums text-sm text-base-content">
            Asking the AI a small question… {seconds} s. This can take up to half a minute.
          </p>
        )}
        {blocked && !running && <p className="text-sm text-muted">Save your changes first: the test uses the saved settings.</p>}
      </div>
      {outcome !== undefined && (
        <div
          role="status"
          data-testid="ai-test-result"
          className={`mt-3 rounded-field px-3 py-2 text-sm ${"failed" in outcome || !outcome.ok ? "bg-error/10 text-error" : "bg-score-high/60"}`}
        >
          {"failed" in outcome ? (
            <p>The test could not run: {outcome.failed}</p>
          ) : (
            <>
              <p>{asSentence(outcome.message)}</p>
              {outcome.ok && outcome.model !== null && outcome.model !== "" && <p className="text-muted">Model: {outcome.model}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ backups and auto-start

type OpsLoad = Loaded<Ops> & { readonly reload: () => void };

/** "Thursday 12 November 2026" for a calendar day ("2026-11-12") or a timestamp. */
function backupDay(date: string, timeZone: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : date;
  return Number.isNaN(new Date(day).getTime()) ? date : formatDate(day, /^\d{4}-\d{2}-\d{2}$/.test(date) ? "UTC" : timeZone);
}

function backupWords(result: BackupResult): { readonly ok: boolean; readonly text: string } {
  const file = result.file?.split("/").at(-1);
  switch (result.kind) {
    case "created":
      return { ok: true, text: `Backed up${file === undefined ? "" : ` to ${file}`}.` };
    case "skipped":
      return { ok: true, text: result.message == null ? `Today's backup${file === undefined ? "" : `, ${file},`} is already there.` : asSentence(result.message) };
    case "failed":
      return { ok: false, text: result.message == null ? "The backup failed." : asSentence(result.message) };
    default: {
      const _exhaustive: never = result.kind;
      return _exhaustive;
    }
  }
}

function Backups({ ops }: { readonly ops: OpsLoad }) {
  const { timeZone } = useAppData();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly text: string } | undefined>(undefined);

  const backUp = () => {
    setBusy(true);
    setResult(undefined);
    backUpNow()
      .then((answer) => {
        setResult(backupWords(answer));
        ops.reload();
      })
      .catch((failure: unknown) => setResult({ ok: false, text: `The backup failed: ${toApiError(failure).message}` }))
      .finally(() => setBusy(false));
  };

  const backups = [...(ops.data?.backups ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Section title="Backups" lead="The app copies its database once a day and keeps the last seven copies.">
      {ops.status === "error" && ops.data === undefined ? (
        <LoadError what="the backups" message={ops.error.message} onRetry={ops.reload} />
      ) : ops.data === undefined ? (
        <div className="skeleton h-20 w-full" />
      ) : backups.length === 0 ? (
        <p className="text-base-content">No backups yet.</p>
      ) : (
        <ul className="divide-y divide-base-300 rounded-box border border-base-300 text-sm" data-testid="backups">
          {backups.map((b) => (
            <li key={b.file} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
              <span>{backupDay(b.date, timeZone)}</span>
              <span className="text-muted">
                {b.file.split("/").at(-1)}, {formatBytes(b.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-group flex flex-wrap items-center gap-3">
        <button type="button" className={`${SECONDARY_BUTTON} btn-sm`} disabled={busy} onClick={backUp}>
          {busy && <span className="loading loading-spinner loading-xs" />}
          Back up now
        </button>
        {result !== undefined && (
          <p role="status" className={`text-sm ${result.ok ? "text-primary" : "text-error"}`} data-testid="backup-result">
            {result.text}
          </p>
        )}
      </div>
      <ForYourAiTool testId="restore-help">
        <p className="font-medium">To go back to a backup</p>
        <p className="mt-1">
          Stop the app first. Then, in Terminal, in the app&rsquo;s folder, run this with the name of the backup you want
          {backups[0] === undefined ? "" : " (here, the newest)"}:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-field bg-base-200 px-3 py-2 font-mono">
          <code>npm run restore -- {backups[0]?.file.split("/").at(-1) ?? "<backup file name>"}</code>
        </pre>
        <p className="mt-1">
          The current database is kept aside first, so nothing is lost.
          {ops.data === undefined ? (
            ""
          ) : (
            <>
              {" "}
              The backups are in <span className="break-all">{ops.data.dataDir}/backups</span>.
            </>
          )}
        </p>
      </ForYourAiTool>
    </Section>
  );
}

function AutoStart({ ops }: { readonly ops: OpsLoad }) {
  const service = ops.data?.service;
  let state: string;
  if (service === undefined) state = "";
  else if (!service.installed) state = "Not set up. The app runs only when you start it yourself.";
  else if (service.running) state = "Set up. The app starts by itself when you log in to the Mac, and it is running now.";
  else if (service.loaded) state = "Set up, but the app is not running right now.";
  else state = "Set up, but not switched on. Log out and in again, or run the command below.";

  return (
    <Section title="Start at login" lead="Whether the app starts by itself when you log in to the Mac.">
      {ops.status === "error" && ops.data === undefined ? (
        <LoadError what="whether it is set up" message={ops.error.message} onRetry={ops.reload} />
      ) : service !== undefined && !service.installed ? (
        <Notice tone="waits">
          <span data-testid="service-state">{state}</span>
        </Notice>
      ) : (
        <p data-testid="service-state">{state}</p>
      )}
      {service?.note != null && service.note !== "" && <p className="mt-1 text-sm text-base-content">{asSentence(service.note.replace(/`/g, ""))}</p>}
      {service !== undefined && !(service.installed && service.loaded) && (service.note == null || service.note === "") && (
        <ForYourAiTool>
          <p>To set it up, run this in Terminal, in the app&rsquo;s folder:</p>
          <pre className="mt-2 overflow-x-auto rounded-field bg-base-200 px-3 py-2 font-mono">
            <code>npm run service:install</code>
          </pre>
        </ForYourAiTool>
      )}
    </Section>
  );
}

/** Terminal commands and paths, folded away: they are for the user's AI coding tool, not for reading. */
function ForYourAiTool({ children, testId }: { readonly children: ReactNode; readonly testId?: string }) {
  return (
    <details className="mt-block text-sm" data-testid={testId}>
      <summary className="cursor-pointer text-muted hover:text-base-content">For your AI coding tool</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
