import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Info,
  ListChecks,
  Loader2,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Target,
  X,
} from "lucide-react";
import type { AutomationStatus, ControlEntry, ControlEvent } from "../api";
import { useAutomation, useControlLog, useControlMutations, useControls } from "../hooks";
import { fullTime, num, relativeAge } from "../format";

type FeedbackTone = "ok" | "warn" | "bad";
interface Feedback {
  tone: FeedbackTone;
  text: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function ageLabel(seconds: number | null | undefined) {
  if (seconds == null) return "never read";
  return relativeAge(Date.now() - seconds * 1000);
}

function eventTime(event: ControlEvent) {
  return fullTime(event.created_at * 1000);
}

function displayValue(control: ControlEntry) {
  const raw = control.raw_value ?? "—";
  if (control.pack_value != null) {
    return `${raw}${control.unit} / pack ${num(control.pack_value, 1)}${control.unit}`;
  }
  return `${raw}${control.unit ? ` ${control.unit}` : ""}`;
}

function draftValue(control: ControlEntry, drafts: Record<string, string>) {
  return drafts[control.id] ?? control.raw_value ?? "";
}

const TARGET_BASE_SOC = 25;
const TARGET_RAMP_PCT_PER_HOUR = 8;

function minutesFromTime(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function timeFromMinutes(totalMinutes: number): string {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function targetWindow(targetSoc: string, targetTime: string): string {
  const soc = Number(targetSoc);
  const targetMinutes = minutesFromTime(targetTime);
  if (!Number.isFinite(soc) || targetMinutes == null) return "when enabled";
  const rampMinutes = Math.max(0, ((soc - TARGET_BASE_SOC) / TARGET_RAMP_PCT_PER_HOUR) * 60);
  return `${timeFromMinutes(targetMinutes - rampMinutes)}-${targetTime}`;
}

function automationExplanation(status: AutomationStatus | undefined, draftEnabled: boolean, targetSoc: string, targetTime: string) {
  const savedEnabled = Boolean(status?.enabled);
  const practicalNow = status?.practical_soc == null ? null : Math.round(status.practical_soc);
  const desiredNow =
    status?.desired_practical_soc_now == null ? null : Math.round(status.desired_practical_soc_now);
  const targetVoltage = status?.target_voltage == null ? null : num(status.target_voltage, 1);
  const targetLabel = `${targetSoc || "—"}% by ${targetTime || "—"}`;
  const windowLabel = targetWindow(targetSoc, targetTime);
  const draftFact =
    savedEnabled === draftEnabled
      ? `Saved mode: ${savedEnabled ? "ON" : "OFF"}`
      : draftEnabled
        ? "Unsaved change: will turn ON after Save target"
        : "Unsaved change: will turn OFF after Save target";

  if (!savedEnabled) {
    return {
      title: "Paused: no automatic writes",
      body:
        "The saved automation state is OFF, so the backend is not trying to reach the target. If automation previously raised A6 and still owns that override, it restores the fallback A6 once.",
      facts: [
        draftFact,
        "Enable and save to start target tracking",
        `When enabled, it watches the target path during ${windowLabel}`,
      ],
    };
  }

  const decision = String(status?.decision ?? "").toLowerCase();
  if (decision.includes("behind")) {
    return {
      title: "Preserving battery to catch up",
      body:
        "The controller is inside the target path and practical SOC is behind. It may raise A6 so PLN carries the load while PV charges the battery, then restore the fallback A6 after the target is reached or time passes.",
      facts: [
        `Target: ${targetLabel}`,
        `Control window: ${windowLabel}`,
        "Evaluation cadence: about every 5 min; writes still obey cooldown and daily cap",
        practicalNow == null ? "Current practical SOC: unknown" : `Current practical SOC: ${practicalNow}%`,
        desiredNow == null ? "Expected-by-now SOC: unknown" : `Expected-by-now SOC: ${desiredNow}%`,
        targetVoltage == null ? "Target voltage: unknown" : `Target voltage: ${targetVoltage}V pack`,
      ],
    };
  }

  if (decision.includes("tracking")) {
    return {
      title: "Tracking: waiting before changing A6",
      body:
        "The target is enabled. The backend checks during the control window, but it only writes A6 when practical SOC falls far enough behind the expected path.",
      facts: [
        `Target: ${targetLabel}`,
        `Control window: ${windowLabel}`,
        "Evaluation cadence: about every 5 min; minimum automation write spacing is 90 min",
        practicalNow == null ? "Current practical SOC: unknown" : `Current practical SOC: ${practicalNow}%`,
        desiredNow == null ? "Expected-by-now SOC: unknown" : `Expected-by-now SOC: ${desiredNow}%`,
      ],
    };
  }

  if (decision.includes("cooldown") || decision.includes("budget")) {
    return {
      title: "Write blocked by safety guardrails",
      body:
        "The controller wanted to act, but a cooldown, daily write cap, or validation rule prevented another write. This protects inverter non-volatile memory and avoids chatter.",
      facts: [
        `Control window: ${windowLabel}`,
        status?.reason ?? "Waiting for the next safe opportunity.",
      ],
    };
  }

  if (decision.includes("target reached") || decision.includes("baseline")) {
    return {
      title: "Target satisfied or baseline active",
      body:
        "The controller is not trying to preserve more battery right now. If it had raised A6, it is restoring or has restored the baseline profile.",
      facts: [
        `Target: ${targetLabel}`,
        `Control window: ${windowLabel}`,
        practicalNow == null ? "Current practical SOC: unknown" : `Current practical SOC: ${practicalNow}%`,
      ],
    };
  }

  return {
    title: "Waiting for enough signal",
    body:
      "The controller needs fresh telemetry and control values before it can decide whether to wait, preserve battery, or restore baseline.",
    facts: [
      `Control window: ${windowLabel}`,
      status?.reason ?? "No automation decision has been recorded yet.",
    ],
  };
}

export default function ControlCenter() {
  const controls = useControls();
  const log = useControlLog();
  const automation = useAutomation();
  const mutations = useControlMutations();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [targetSoc, setTargetSoc] = useState("95");
  const [targetTime, setTargetTime] = useState("17:15");
  const [baselineA6, setBaselineA6] = useState("12.4");
  // Tracks unsaved edits so a background refetch (every 30s) never clobbers them.
  const [formDirty, setFormDirty] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const next = { ...drafts };
    let changed = false;
    for (const control of controls.data?.controls ?? []) {
      if (next[control.id] == null && control.raw_value != null) {
        next[control.id] = control.raw_value;
        changed = true;
      }
    }
    if (changed) setDrafts(next);
  }, [controls.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const state = automation.data?.automation.state;
    if (!state) return;
    // Don't overwrite in-progress edits from a background poll.
    if (formDirty) return;
    setEnabled(Boolean(state.enabled));
    setTargetSoc(String(state.target_practical_soc));
    setTargetTime(state.target_time);
    setBaselineA6(String(state.baseline_a6));
  }, [automation.data?.automation.state, formDirty]);

  const grouped = useMemo(() => {
    const battery: ControlEntry[] = [];
    const other: ControlEntry[] = [];
    for (const control of controls.data?.controls ?? []) {
      if (control.group === "battery") battery.push(control);
      else other.push(control);
    }
    return { battery, other };
  }, [controls.data]);

  const status = automation.data?.automation;
  const savedEnabled = Boolean(status?.enabled);
  const explain = automationExplanation(status, enabled, targetSoc, targetTime);
  const windowLabel = targetWindow(targetSoc, targetTime);
  const nextEvaluation =
    !savedEnabled
      ? "paused"
      : status?.next_check_at == null
        ? "waiting"
        : fullTime(status.next_check_at * 1000);
  const busy =
    mutations.readAll.isPending ||
    mutations.write.isPending ||
    mutations.updateAutomation.isPending ||
    mutations.evaluateAutomation.isPending ||
    mutations.a6Test.isPending;

  const writingId = mutations.write.isPending ? mutations.write.variables?.id ?? null : null;
  const readingId = mutations.readOne.isPending ? mutations.readOne.variables ?? null : null;

  function setDraft(id: string, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  }

  function readControl(control: ControlEntry) {
    mutations.readOne.mutate(control.id, {
      onSuccess: () => setFeedback({ tone: "ok", text: `Read ${control.label} from inverter.` }),
      onError: (error) =>
        setFeedback({ tone: "bad", text: `Read ${control.label} failed: ${errorText(error)}` }),
    });
  }

  function readAll() {
    mutations.readAll.mutate(undefined, {
      onSuccess: (data) =>
        setFeedback({ tone: "ok", text: `Refreshed ${data.controls.length} controls from inverter.` }),
      onError: (error) =>
        setFeedback({ tone: "bad", text: `Read all failed: ${errorText(error)}` }),
    });
  }

  function sendControl(control: ControlEntry) {
    const value = draftValue(control, drafts);
    const reason = `Manual ${control.label} change from ${control.raw_value ?? "unknown"} to ${value}`;
    if (!window.confirm(`${control.label}\n\nSend ${value || "(blank)"} to the inverter?`)) return;
    mutations.write.mutate(
      { id: control.id, value, reason },
      {
        onSuccess: (data) => {
          const result = data.result;
          if (result.status === "written") {
            setFeedback({
              tone: "ok",
              text: `${control.label} written: ${result.before ?? "—"} → ${result.verified ?? result.requested}.`,
            });
          } else if (result.status === "skipped") {
            setFeedback({ tone: "warn", text: `${control.label} unchanged: ${result.reason}` });
          } else {
            setFeedback({ tone: "bad", text: `${control.label} write failed: ${result.reason}` });
          }
        },
        onError: (error) =>
          setFeedback({ tone: "bad", text: `${control.label} write failed: ${errorText(error)}` }),
      },
    );
  }

  function saveAutomation() {
    const socValue = Number(targetSoc);
    const baselineValue = Number(baselineA6);
    if (!Number.isFinite(socValue) || socValue < 0 || socValue > 100) {
      setFeedback({ tone: "bad", text: "Target practical SOC must be between 0 and 100." });
      return;
    }
    if (!minutesFromTime(targetTime)) {
      setFeedback({ tone: "bad", text: "Target time must be a valid HH:MM value." });
      return;
    }
    if (!Number.isFinite(baselineValue)) {
      setFeedback({ tone: "bad", text: "Disabled fallback A6 must be a number." });
      return;
    }
    mutations.updateAutomation.mutate(
      {
        enabled,
        target_practical_soc: socValue,
        target_time: targetTime,
        baseline_a6: baselineValue,
      },
      {
        onSuccess: () => {
          setFormDirty(false);
          setFeedback({ tone: "ok", text: `Target saved: ${socValue}% by ${targetTime} (${enabled ? "ON" : "OFF"}).` });
        },
        onError: (error) =>
          setFeedback({ tone: "bad", text: `Save target failed: ${errorText(error)}` }),
      },
    );
  }

  function evaluateNow() {
    mutations.evaluateAutomation.mutate(undefined, {
      onSuccess: (data) =>
        setFeedback({ tone: "ok", text: `Evaluated: ${data.automation.decision}.` }),
      onError: (error) =>
        setFeedback({ tone: "bad", text: `Evaluate failed: ${errorText(error)}` }),
    });
  }

  function runA6Test() {
    if (
      !window.confirm(
        "A6 +0.1 restore test\n\nThis writes A6 +0.1V to the inverter and then restores it. Continue?",
      )
    )
      return;
    mutations.a6Test.mutate(undefined, {
      onSuccess: () => setFeedback({ tone: "ok", text: "A6 +0.1 restore test completed." }),
      onError: (error) => setFeedback({ tone: "bad", text: `A6 test failed: ${errorText(error)}` }),
    });
  }

  return (
    <section className="section fade-in">
      <div className="section-head">
        <h2>
          <SlidersHorizontal size={14} strokeWidth={1.8} /> Control Center
        </h2>
        <span className="note">Guarded writes, practical-SOC target, and full action log</span>
      </div>

      {feedback && (
        <div className={`control-feedback control-feedback--${feedback.tone}`} role="status" aria-live="polite">
          <span className="control-feedback__icon">
            {feedback.tone === "ok" ? (
              <CheckCircle2 size={15} strokeWidth={1.9} />
            ) : feedback.tone === "warn" ? (
              <Info size={15} strokeWidth={1.9} />
            ) : (
              <AlertTriangle size={15} strokeWidth={1.9} />
            )}
          </span>
          <span className="control-feedback__text">{feedback.text}</span>
          <button
            type="button"
            className="control-feedback__close"
            aria-label="Dismiss message"
            onClick={() => setFeedback(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="control-center">
        <div className="control-panel control-panel--automation">
          <div className="control-panel__head">
            <div>
              <div className="panel__label">
                <Target size={14} strokeWidth={1.8} /> Practical SOC target
              </div>
              <p className="control-panel__sub">
                Uses practical SOC mapped to pack voltage. Disabled mode restores baseline A6 once only
                when automation owns an override.
              </p>
            </div>
            <div className={`automation-mode__badge ${savedEnabled ? "is-on" : "is-off"}`}>
              <span className="automation-mode__dot" /> {savedEnabled ? "Active" : "Paused"}
            </div>
          </div>

          <div className="automation-switch">
            <label className="control-switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={enabled}
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setFormDirty(true);
                }}
              />
              <span className="control-switch__track" aria-hidden="true">
                <span className="control-switch__thumb" />
              </span>
              <span className="control-switch__label">
                <strong>Enable automatic A6 changes</strong>
                <small>Automation writes A6 to track the practical-SOC target</small>
              </span>
            </label>
            <div className="automation-switch__state">
              {formDirty ? (
                <span className="automation-switch__dirty">Unsaved · press Save target</span>
              ) : (
                <span className="automation-switch__saved">
                  Saved: {savedEnabled ? "ON" : "OFF"}
                </span>
              )}
            </div>
          </div>

          <div className="automation-grid">
            <label className="control-field">
              <span>Target practical SOC</span>
              <input
                className="mono"
                type="number"
                min={0}
                max={100}
                step={1}
                value={targetSoc}
                onChange={(event) => {
                  setTargetSoc(event.target.value);
                  setFormDirty(true);
                }}
              />
            </label>
            <label className="control-field">
              <span>Target time</span>
              <input
                className="mono"
                type="time"
                value={targetTime}
                onChange={(event) => {
                  setTargetTime(event.target.value);
                  setFormDirty(true);
                }}
              />
            </label>
            <label className="control-field">
              <span>Disabled fallback A6</span>
              <input
                className="mono"
                type="number"
                min={12.4}
                max={13.5}
                step={0.1}
                value={baselineA6}
                onChange={(event) => {
                  setBaselineA6(event.target.value);
                  setFormDirty(true);
                }}
              />
            </label>
          </div>

          <div className="automation-status">
            <div>
              <span>Current state</span>
              <strong>{status?.decision ?? "unknown"}</strong>
            </div>
            <div>
              <span>Practical SOC now</span>
              <strong>{status?.practical_soc == null ? "—" : `${Math.round(status.practical_soc)}%`}</strong>
            </div>
            <div>
              <span>Control window</span>
              <strong>{savedEnabled ? windowLabel : "paused"}</strong>
            </div>
            <div>
              <span>Next evaluation</span>
              <strong>{nextEvaluation}</strong>
            </div>
          </div>

          <div className="automation-explainer">
            <div>
              <span>What it is doing now</span>
              <strong>{explain.title}</strong>
            </div>
            <p>{explain.body}</p>
            <ul>
              {explain.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div className="control-actions">
            <button onClick={saveAutomation} disabled={busy} className={formDirty ? "control-actions__primary" : ""}>
              {mutations.updateAutomation.isPending && <Loader2 size={13} className="spin" />}
              Save target
            </button>
            <button onClick={evaluateNow} disabled={busy}>
              {mutations.evaluateAutomation.isPending && <Loader2 size={13} className="spin" />}
              Evaluate now
            </button>
            <button className="control-actions__danger" onClick={runA6Test} disabled={busy}>
              {mutations.a6Test.isPending && <Loader2 size={13} className="spin" />}
              A6 +0.1 restore test
            </button>
          </div>
        </div>

        <div className="control-panel">
          <div className="control-panel__head">
            <div>
              <div className="panel__label">
                <RefreshCw size={14} strokeWidth={1.8} /> Device controls
              </div>
              <p className="control-panel__sub">
                Values show read freshness. Writes are read-before-write and verified after send.
              </p>
            </div>
            <button className="control-read-all" onClick={readAll} disabled={busy}>
              {mutations.readAll.isPending && <Loader2 size={13} className="spin" />}
              {mutations.readAll.isPending ? "Reading…" : "Read all"}
            </button>
          </div>

          {controls.isLoading ? (
            <div className="audit-card audit-card--muted">Loading cached controls…</div>
          ) : controls.error ? (
            <div className="audit-card audit-card--muted">Could not load controls: {errorText(controls.error)}</div>
          ) : (
            <>
              <ControlGroup
                title="Battery setting"
                controls={grouped.battery}
                drafts={drafts}
                setDraft={setDraft}
                sendControl={sendControl}
                readOne={readControl}
                busy={busy}
                writingId={writingId}
                readingId={readingId}
              />
              <ControlGroup
                title="Other setting"
                controls={grouped.other}
                drafts={drafts}
                setDraft={setDraft}
                sendControl={sendControl}
                readOne={readControl}
                busy={busy}
                writingId={writingId}
                readingId={readingId}
              />
            </>
          )}
        </div>

        <div className="control-panel">
          <div className="control-panel__head">
            <div>
              <div className="panel__label">
                <ListChecks size={14} strokeWidth={1.8} /> Action timeline
              </div>
              <p className="control-panel__sub">Every read, skip, write, restore, and verify includes a reason.</p>
            </div>
          </div>
          <div className="event-log">
            {log.isLoading ? (
              <div className="audit-card audit-card--muted">Loading action log…</div>
            ) : log.error ? (
              <div className="audit-card audit-card--muted">Could not load log: {errorText(log.error)}</div>
            ) : (log.data?.events ?? []).length === 0 ? (
              <div className="audit-card audit-card--muted">No control events yet.</div>
            ) : (
              (log.data?.events ?? []).map((event) => <EventRow key={event.id} event={event} />)
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

interface ControlGroupProps {
  title: string;
  controls: ControlEntry[];
  drafts: Record<string, string>;
  setDraft: (id: string, value: string) => void;
  sendControl: (control: ControlEntry) => void;
  readOne: (control: ControlEntry) => void;
  busy: boolean;
  writingId: string | null;
  readingId: string | null;
}

function ControlGroup({
  title,
  controls,
  drafts,
  setDraft,
  sendControl,
  readOne,
  busy,
  writingId,
  readingId,
}: ControlGroupProps) {
  return (
    <div className="control-group">
      <div className="control-group__title">{title}</div>
      {controls.length === 0 ? (
        <div className="audit-card audit-card--muted">No controls in this group.</div>
      ) : (
        <div className="control-table">
          {controls.map((control) => {
            const value = draftValue(control, drafts);
            const changed = value !== (control.raw_value ?? "");
            const isWriting = writingId === control.id;
            const isReading = readingId === control.id;
            return (
              <div className="control-row" key={control.id}>
                <div className="control-row__meta">
                  <strong>{control.label}</strong>
                  <span className="mono">{control.id}</span>
                  {control.hint && <small>{control.hint}</small>}
                  {!control.writable && <small className="control-row__ro">read-only</small>}
                </div>
                <div className="control-row__current">
                  <span className="mono">{displayValue(control)}</span>
                  <small className={control.stale ? "is-stale" : ""}>
                    <Clock3 size={11} /> {ageLabel(control.read_at)}
                    {control.stale && control.read_at != null ? " · stale" : ""}
                  </small>
                </div>
                <div className="control-row__edit">
                  {control.type === "enum" && control.options?.length ? (
                    <select
                      aria-label={`${control.label} value`}
                      value={value}
                      onChange={(event) => setDraft(control.id, event.target.value)}
                      disabled={!control.writable}
                    >
                      <option value="">Select…</option>
                      {control.options.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`${control.label} value`}
                      className="mono"
                      type={control.type === "number" ? "number" : "text"}
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={value}
                      onChange={(event) => setDraft(control.id, event.target.value)}
                      disabled={!control.writable}
                    />
                  )}
                </div>
                <div className="control-row__ops">
                  <button
                    onClick={() => readOne(control)}
                    disabled={busy}
                    aria-label={`Read ${control.label} from inverter`}
                  >
                    {isReading && <Loader2 size={12} className="spin" />}
                    Read
                  </button>
                  <button
                    onClick={() => sendControl(control)}
                    disabled={busy || !control.writable || !changed}
                    title={
                      !control.writable
                        ? "This control is read-only"
                        : !changed
                          ? "Edit the value before sending"
                          : `Send ${value || "(blank)"} to the inverter`
                    }
                    aria-label={`Send ${control.label} to inverter`}
                  >
                    {isWriting ? <Loader2 size={12} className="spin" /> : <Send size={12} />} Send
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ControlEvent }) {
  return (
    <div className={`event-row event-row--${event.status}`}>
      <div className="event-row__time mono">{eventTime(event)}</div>
      <div className="event-row__body">
        <div className="event-row__head">
          <strong>{event.action}</strong>
          <span>{event.actor}</span>
          {event.field_id && <span className="mono">{event.field_id}</span>}
          <span>{event.status}</span>
        </div>
        <p>{event.reason}</p>
        {(event.value_before != null || event.value_after != null) && (
          <div className="event-row__values mono">
            {event.value_before ?? "—"} → {event.value_after ?? "—"}
          </div>
        )}
      </div>
    </div>
  );
}

