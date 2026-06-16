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
import type { AutomationStatus, ControlEntry, ControlEvent, ThresholdEntry } from "../api";
import { useAutomation, useControlLog, useControlMutations, useControls } from "../hooks";
import { fullTime, num, relativeAge, watts } from "../format";

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

function draftValue(control: ControlEntry, drafts: Record<string, string>) {
  return drafts[control.id] ?? control.raw_value ?? "";
}

function rawControlValue(control: ControlEntry) {
  return control.raw_value ?? "";
}

const TARGET_BASE_SOC = 25;
const OPERATION_START_MINUTES = 6 * 60 + 30;

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

function targetSchedule(targetSoc: string, targetTime: string): string {
  const soc = Number(targetSoc);
  const targetMinutes = minutesFromTime(targetTime);
  if (!Number.isFinite(soc) || targetMinutes == null) return "when enabled";
  if (soc <= TARGET_BASE_SOC || targetMinutes <= OPERATION_START_MINUTES) return "Start now";
  return `Start ${timeFromMinutes(OPERATION_START_MINUTES)}`;
}

function automationExplanation(status: AutomationStatus | undefined, draftEnabled: boolean, targetSoc: string, targetTime: string) {
  const savedEnabled = Boolean(status?.enabled);
  const targetLabel = `${targetSoc || "—"}% by ${targetTime || "—"}`;
  const activeOverride = Boolean(status?.state.active_override);
  const decision = String(status?.decision ?? "").toLowerCase();
  const reason = String(status?.reason ?? "");
  const reasonLower = reason.toLowerCase();
  const draftFact =
    savedEnabled === draftEnabled
      ? `Saved mode: ${savedEnabled ? "ON" : "OFF"}`
      : draftEnabled
        ? "Unsaved change: will turn ON after Save target"
        : "Unsaved change: will turn OFF after Save target";

  if (!savedEnabled) {
    if (activeOverride) {
      const restoreBlocked =
        decision.includes("cleanup restore failed") ||
        decision.includes("cooldown") ||
        decision.includes("budget") ||
        reasonLower.includes("could not restore fallback") ||
        reasonLower.includes("could not restore baseline");
      if (restoreBlocked) {
        return {
          title: "Paused: fallback restore blocked",
          body:
            `Target chasing is off, but automation still owns a previous A6/A7 override and could not restore the fallback band. ${reason || "Check the action timeline for the blocked cleanup write."} ${draftFact}.`,
        };
      }
      return {
        title: "Paused: restoring fallback",
        body:
          `Target chasing is off. The backend may write A6/A7 only to clear the previous automation override and return to the fallback band. ${draftFact}.`,
      };
    }
    return {
      title: "Paused: no automatic writes",
      body:
        `Automation is not trying to reach a target and does not own an A6/A7 override. ${draftFact}.`,
    };
  }

  if (decision.includes("before operation start")) {
    return {
      title: "Waiting for start time",
      body:
        "Automation is enabled, but it will not write A6/A7 before the morning start time. If it still owns yesterday's raised band, it restores the fallback band once.",
    };
  }

  if (decision.includes("behind")) {
    return {
      title: "Preserving battery to catch up",
      body:
        "Practical SOC is behind the solar-weighted path. Automation keeps the load on PLN and holds the protection band so the battery does not drain further before the target time.",
    };
  }

  if (decision.includes("holding override") || decision.includes("holding protection band")) {
    return {
      title: "Target reached: holding until target time",
      body:
        "The target is currently satisfied. Automation keeps the protection band active until the target time so the inverter does not drain the battery early.",
    };
  }

  if (decision.includes("tracking")) {
    return {
      title: "Tracking: waiting before changing thresholds",
      body:
        "The target is enabled. The backend follows a solar-weighted path that expects most progress around midday, and only writes the A6/A7 band when practical SOC falls far enough behind or an active band needs holding.",
    };
  }

  if (decision.includes("cooldown") || decision.includes("budget")) {
    return {
      title: "Write blocked by safety guardrails",
      body:
        `The controller wanted to act, but a 15-minute batch cooldown or validation rule prevented another write. ${status?.reason ?? "Waiting for the next safe opportunity."}`,
    };
  }

  if (decision.includes("target reached") || decision.includes("baseline")) {
    return {
      title: "Baseline active",
      body:
        `Automation is not preserving extra battery right now for ${targetLabel}. If it previously raised A6/A7, it is restoring or has restored the fallback band.`,
    };
  }

  return {
    title: "Waiting for enough signal",
    body:
      "The controller needs fresh telemetry and control values before it can decide whether to wait, preserve the A6/A7 band, or restore baseline.",
  };
}

const feedbackToneClass: Record<FeedbackTone, string> = {
  ok: "border-l-charge",
  warn: "border-l-solar",
  bad: "border-l-bad",
};
const feedbackIconToneClass: Record<FeedbackTone, string> = {
  ok: "text-charge",
  warn: "text-solar",
  bad: "text-bad",
};
const eventToneClass: Record<string, string> = {
  success: "border-l-charge",
  failed: "border-l-bad",
  skipped: "border-l-grid",
  sent: "border-l-solar",
};

interface ControlCenterProps {
  voltageThresholds?: ThresholdEntry[];
}

export default function ControlCenter({ voltageThresholds = [] }: ControlCenterProps) {
  const controls = useControls();
  const log = useControlLog();
  const automation = useAutomation();
  const mutations = useControlMutations();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, boolean>>({});
  const [enabled, setEnabled] = useState(false);
  const [targetSoc, setTargetSoc] = useState("95");
  const [targetTime, setTargetTime] = useState("17:15");
  const [baselineA6, setBaselineA6] = useState("12.4");
  const [baselineA7, setBaselineA7] = useState("11.7");
  // Tracks unsaved edits so a background refetch (every 30s) never clobbers them.
  const [formDirty, setFormDirty] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const control of controls.data?.controls ?? []) {
        if (dirtyDrafts[control.id] || control.raw_value == null) continue;
        if (next[control.id] !== control.raw_value) {
          next[control.id] = control.raw_value;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [controls.data?.controls, dirtyDrafts]);

  function clearDirtyDrafts(ids: string[]) {
    setDirtyDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  function setReadDrafts(nextControls: ControlEntry[]) {
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const control of nextControls) {
        const value = rawControlValue(control);
        if (next[control.id] !== value) {
          next[control.id] = value;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    clearDirtyDrafts(nextControls.map((control) => control.id));
  }

  function setDraft(control: ControlEntry, value: string) {
    setDrafts((prev) => ({ ...prev, [control.id]: value }));
    setDirtyDrafts((prev) => {
      const changed = value !== rawControlValue(control);
      if (changed) return prev[control.id] ? prev : { ...prev, [control.id]: true };
      if (!prev[control.id]) return prev;
      const next = { ...prev };
      delete next[control.id];
      return next;
    });
  }

  function setWrittenDraft(controlId: string, value: string | null) {
    setDrafts((prev) => ({ ...prev, [controlId]: value ?? "" }));
    clearDirtyDrafts([controlId]);
  }

  useEffect(() => {
    const state = automation.data?.automation.state;
    if (!state) return;
    // Don't overwrite in-progress edits from a background poll.
    if (formDirty) return;
    setEnabled(Boolean(state.enabled));
    setTargetSoc(String(state.target_practical_soc));
    setTargetTime(state.target_time);
    setBaselineA6(String(state.baseline_a6));
    setBaselineA7(String(state.baseline_a7));
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

  const controlLabelColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const threshold of voltageThresholds) {
      map.set(threshold.field_id, threshold.color);
    }
    return map;
  }, [voltageThresholds]);

  const status = automation.data?.automation;
  const savedEnabled = Boolean(status?.enabled);
  const cleanupPending = !savedEnabled && Boolean(status?.state.active_override);
  const explain = automationExplanation(status, enabled, targetSoc, targetTime);
  const scheduleLabel = targetSchedule(targetSoc, targetTime);
  const nextEvaluation =
    cleanupPending
      ? "cleanup pending"
      : !savedEnabled
      ? "paused"
      : status?.next_check_at == null
        ? "waiting"
        : fullTime(status.next_check_at * 1000);
  const targetBandLabel =
    status?.target_a6 == null || status.target_a7 == null
      ? "—"
      : `A6 ${num(status.target_a6, 1)} / A7 ${num(status.target_a7, 1)}`;
  const targetSummary = `${scheduleLabel}, ${targetSoc || "—"}% by ${targetTime || "—"}`;
  const desiredSummary =
    status?.desired_practical_soc_now == null ? "—" : `${Math.round(status.desired_practical_soc_now)}%`;
  const practicalSummary = status?.practical_soc == null ? "—" : `${Math.round(status.practical_soc)}%`;
  const socGap =
    status?.desired_practical_soc_now == null || status.practical_soc == null
      ? null
      : Math.max(0, Math.round(status.desired_practical_soc_now - status.practical_soc));
  const pv = watts(status?.latest?.pv_power);
  const load = watts(status?.latest?.load_power == null ? null : status.latest.load_power * 1000);
  const powerSummary = `PV ${pv.value}${pv.unit ? ` ${pv.unit}` : ""} / load ${load.value}${load.unit ? ` ${load.unit}` : ""}`;
  const busy =
    mutations.readAll.isPending ||
    mutations.write.isPending ||
    mutations.updateAutomation.isPending ||
    mutations.evaluateAutomation.isPending;

  const writingId = mutations.write.isPending ? mutations.write.variables?.id ?? null : null;
  const readingId = mutations.readOne.isPending ? mutations.readOne.variables ?? null : null;

  function readControl(control: ControlEntry) {
    mutations.readOne.mutate(control.id, {
      onSuccess: (data) => {
        setReadDrafts([data.control]);
        setFeedback({
          tone: "ok",
          text: `Read ${control.label} from inverter: ${data.control.raw_value ?? "—"}.`,
        });
      },
      onError: (error) =>
        setFeedback({ tone: "bad", text: `Read ${control.label} failed: ${errorText(error)}` }),
    });
  }

  function readAll() {
    mutations.readAll.mutate(undefined, {
      onSuccess: (data) => {
        setReadDrafts(data.controls);
        setFeedback({ tone: "ok", text: `Refreshed ${data.controls.length} controls from inverter.` });
      },
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
          setWrittenDraft(control.id, result.verified ?? result.requested);
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
    const baselineA6Value = Number(baselineA6);
    const baselineA7Value = Number(baselineA7);
    if (!Number.isFinite(socValue) || socValue < 0 || socValue > 100) {
      setFeedback({ tone: "bad", text: "Target practical SOC must be between 0 and 100." });
      return;
    }
    if (!minutesFromTime(targetTime)) {
      setFeedback({ tone: "bad", text: "Target time must be a valid HH:MM value." });
      return;
    }
    if (!Number.isFinite(baselineA6Value)) {
      setFeedback({ tone: "bad", text: "Disabled fallback A6 must be a number." });
      return;
    }
    if (!Number.isFinite(baselineA7Value)) {
      setFeedback({ tone: "bad", text: "Disabled fallback A7 must be a number." });
      return;
    }
    if (baselineA6Value <= baselineA7Value) {
      setFeedback({ tone: "bad", text: "Disabled fallback band must satisfy A6 > A7." });
      return;
    }
    mutations.updateAutomation.mutate(
      {
        enabled,
        target_practical_soc: socValue,
        target_time: targetTime,
        baseline_a6: baselineA6Value,
        baseline_a7: baselineA7Value,
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


  return (
    <section className="mt-8 animate-[fadein_0.5s_ease_both] sm:mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="m-0 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-dim">
          <SlidersHorizontal size={14} strokeWidth={1.8} /> Control Center
        </h2>
      </div>

      {feedback && (
        <div
          className={`mb-3 flex items-start gap-2 rounded-card border border-line border-l-2 bg-panel-hi px-3 py-2.5 text-sm leading-relaxed ${feedbackToneClass[feedback.tone]}`}
          role="status"
          aria-live="polite"
        >
          <span className={`mt-px inline-flex shrink-0 ${feedbackIconToneClass[feedback.tone]}`}>
            {feedback.tone === "ok" ? (
              <CheckCircle2 size={15} strokeWidth={1.9} />
            ) : feedback.tone === "warn" ? (
              <Info size={15} strokeWidth={1.9} />
            ) : (
              <AlertTriangle size={15} strokeWidth={1.9} />
            )}
          </span>
          <span className="min-w-0 flex-1 wrap-break-word text-text">{feedback.text}</span>
          <button
            type="button"
            className="-mr-1 -mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-card p-0 text-faint transition-colors hover:bg-panel hover:text-text"
            aria-label="Dismiss message"
            onClick={() => setFeedback(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        <div className="rounded-card border border-line bg-panel p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3 sm:mb-3.5 sm:gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-dim">
                <Target size={14} strokeWidth={1.8} /> Practical SOC target
              </div>
              <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-faint">
                Uses practical SOC mapped to pack voltage. Disabled mode restores the baseline A6/A7 band once only
                when automation owns an override.
              </p>
            </div>
            <div
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 font-mono text-xs tracking-wide ${
                savedEnabled
                  ? "bg-charge/10 text-charge"
                  : cleanupPending
                    ? "bg-solar/10 text-solar"
                  : "bg-panel-hi text-faint"
              }`}
            >
              {savedEnabled ? "Active" : cleanupPending ? "Cleanup" : "Paused"}
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5 rounded-card border border-line bg-panel-hi px-2.5 py-2.5 sm:mb-3.5 sm:gap-3.5 sm:px-3">
            <label className="inline-flex min-w-0 cursor-pointer items-center gap-2.5">
              <input
                className="control-switch-input"
                type="checkbox"
                role="switch"
                aria-checked={enabled}
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setFormDirty(true);
                }}
              />
              <span className="control-switch-track" aria-hidden="true">
                <span className="control-switch-thumb" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-text">Enable automatic A6/A7 band changes</span>
              </span>
            </label>
            <div className="w-full text-left sm:w-auto sm:shrink-0 sm:text-right">
              {formDirty ? (
                <span className="font-mono text-xs tracking-wide text-solar">Unsaved · press Save target</span>
              ) : (
                <span className="font-mono text-xs tracking-wide text-faint">
                  Saved: {savedEnabled ? "ON" : "OFF"}
                </span>
              )}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:mt-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-faint">Target SOC</span>
              <input
                className="h-8 w-full rounded-card border border-line bg-panel-hi px-2.5 font-mono text-sm text-text outline-none focus:border-line-hi"
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
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-faint">Target time</span>
              <input
                className="h-8 w-full rounded-card border border-line bg-panel-hi px-2.5 font-mono text-sm text-text outline-none focus:border-line-hi"
                type="time"
                value={targetTime}
                onChange={(event) => {
                  setTargetTime(event.target.value);
                  setFormDirty(true);
                }}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-faint">Fallback A6 voltage</span>
              <input
                className="h-8 w-full rounded-card border border-line bg-panel-hi px-2.5 font-mono text-sm text-text outline-none focus:border-line-hi"
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
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-faint">Fallback A7 voltage</span>
              <input
                className="h-8 w-full rounded-card border border-line bg-panel-hi px-2.5 font-mono text-sm text-text outline-none focus:border-line-hi"
                type="number"
                min={11.2}
                max={13.5}
                step={0.1}
                value={baselineA7}
                onChange={(event) => {
                  setBaselineA7(event.target.value);
                  setFormDirty(true);
                }}
              />
            </label>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
            <div className="bg-panel-hi px-2.5 py-2 sm:px-3">
              <span className="block text-[10px] uppercase tracking-wider text-faint">Target</span>
              <span className="mt-0.5 block font-mono text-xs font-medium text-text">{targetSummary}</span>
            </div>
            <div className="bg-panel-hi px-2.5 py-2 sm:px-3">
              <span className="block text-[10px] uppercase tracking-wider text-faint">Practical / expected</span>
              <span className="mt-0.5 block font-mono text-xs font-medium text-text">
                {practicalSummary} / {desiredSummary}
                {socGap != null && socGap > 0 && (
                  <span className="ml-1 text-[10px] font-normal text-faint">(-{socGap})</span>
                )}
              </span>
            </div>
            <div className="bg-panel-hi px-2.5 py-2 sm:px-3">
              <span className="block text-[10px] uppercase tracking-wider text-faint">Power now</span>
              <span className="mt-0.5 block font-mono text-xs font-medium text-text">{powerSummary}</span>
            </div>
            <div className="bg-panel-hi px-2.5 py-2 sm:px-3">
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-faint">
                Protection band
                <span className="group relative inline-flex">
                  <button
                    type="button"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line text-faint transition-colors hover:border-line-hi hover:text-text focus-visible:border-line-hi focus-visible:text-text focus-visible:outline-none"
                    aria-label="Protection band limits info"
                  >
                    <Info size={9} strokeWidth={2} />
                  </button>
                  <span className="pointer-events-none invisible absolute left-1/2 top-full z-20 mt-1.5 w-44 -translate-x-1/2 rounded-card border border-line bg-panel px-2 py-1.5 text-[10px] normal-case tracking-normal text-faint opacity-0 shadow-[0_8px_20px_rgba(0,0,0,0.35)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                    {status?.target_band_capped ? "Capped by inverter limits" : "Within inverter limits"}
                  </span>
                </span>
              </span>
              <span className="mt-0.5 block font-mono text-xs font-medium text-text">
                {targetBandLabel}
              </span>
            </div>
            <div className="bg-panel-hi px-2.5 py-2 sm:px-3">
              <span className="block text-[10px] uppercase tracking-wider text-faint">Next check</span>
              <span className="mt-0.5 block font-mono text-xs font-medium text-text">{nextEvaluation}</span>
            </div>
          </div>

          <div className="mt-2.5 rounded-card border border-line border-l-2 border-l-battery bg-panel-hi px-3 py-2.5">
            <span className="text-xs font-semibold text-text">Now: {explain.title}</span>
            <p className="mt-1.5 text-xs leading-relaxed text-dim">{explain.body}</p>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={saveAutomation}
              disabled={busy}
              className={`inline-flex min-h-8 items-center justify-center gap-1.5 rounded-card border border-line bg-panel-hi px-3 text-xs text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45 ${
                formDirty ? "border-charge bg-charge/15 text-text" : ""
              }`}
            >
              {mutations.updateAutomation.isPending && <Loader2 size={13} className="animate-spin" />}
              Save target
            </button>
            <button
              onClick={evaluateNow}
              disabled={busy}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-card border border-line bg-panel-hi px-3 text-xs text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45"
            >
              {mutations.evaluateAutomation.isPending && <Loader2 size={13} className="animate-spin" />}
              Evaluate now
            </button>
          </div>
        </div>

        <div className="rounded-card border border-line bg-panel p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3 sm:mb-3.5 sm:gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-dim">
                <RefreshCw size={14} strokeWidth={1.8} /> Device controls
              </div>
              <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-faint">
                Values show read freshness. Writes are read-before-write and verified after send.
              </p>
            </div>
            <button
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-card border border-line bg-panel-hi px-3 text-xs text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45"
              onClick={readAll}
              disabled={busy}
            >
              {mutations.readAll.isPending && <Loader2 size={13} className="animate-spin" />}
              {mutations.readAll.isPending ? "Reading…" : "Read all"}
            </button>
          </div>

          {controls.isLoading ? (
            <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
              Loading cached controls…
            </div>
          ) : controls.error ? (
            <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
              Could not load controls: {errorText(controls.error)}
            </div>
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
                controlLabelColors={controlLabelColors}
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
                controlLabelColors={controlLabelColors}
              />
            </>
          )}
        </div>

        <div className="rounded-card border border-line bg-panel p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3 sm:mb-3.5 sm:gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-dim">
                <ListChecks size={14} strokeWidth={1.8} /> Action timeline
              </div>
              <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-faint">
                Every read, skip, write, restore, and verify includes a reason.
              </p>
            </div>
          </div>
          <div className="flex max-h-112 flex-col gap-2 overflow-auto pr-0.5">
            {log.isLoading ? (
              <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
                Loading action log…
              </div>
            ) : log.error ? (
              <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
                Could not load log: {errorText(log.error)}
              </div>
            ) : (log.data?.events ?? []).length === 0 ? (
              <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
                No control events yet.
              </div>
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
  setDraft: (control: ControlEntry, value: string) => void;
  sendControl: (control: ControlEntry) => void;
  readOne: (control: ControlEntry) => void;
  busy: boolean;
  writingId: string | null;
  readingId: string | null;
  controlLabelColors: ReadonlyMap<string, string>;
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
  controlLabelColors,
}: ControlGroupProps) {
  return (
    <div className="mt-3.5">
      <div className="mb-2 text-xs uppercase tracking-wider text-dim">{title}</div>
      {controls.length === 0 ? (
        <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
          No controls in this group.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {controls.map((control) => {
            const value = draftValue(control, drafts);
            const changed = value !== rawControlValue(control);
            const isWriting = writingId === control.id;
            const isReading = readingId === control.id;
            const labelColor = controlLabelColors.get(control.id);
            const enumValues = new Set((control.options ?? []).map((option) => option.value));
            const unknownEnumValue = control.type === "enum" && value && !enumValues.has(value) ? value : null;
            return (
              <div
                className="grid grid-cols-1 items-center gap-x-3 gap-y-2 rounded-card border border-line bg-panel-hi px-2.5 py-2 sm:px-3 lg:grid-cols-12"
                key={control.id}
              >
                <div className="min-w-0 lg:col-span-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`text-xs font-medium leading-snug ${labelColor ? "" : "text-text"}`}
                      style={labelColor ? { color: labelColor } : undefined}
                    >
                      {control.label}
                    </span>
                    {!control.writable && (
                      <span className="shrink-0 text-xs font-medium leading-snug text-faint">read-only</span>
                    )}
                    {control.hint && (
                      <span className="group relative inline-flex shrink-0">
                        <button
                          type="button"
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-line text-[10px] font-semibold text-faint transition-colors hover:border-line-hi hover:text-text focus-visible:border-line-hi focus-visible:text-text focus-visible:outline-none"
                          aria-label={`${control.label} description`}
                        >
                          i
                        </button>
                        <span className="pointer-events-none invisible absolute left-1/2 top-full z-20 mt-1.5 w-56 -translate-x-1/2 rounded-card border border-line bg-panel px-2 py-1.5 text-[10px] leading-tight text-faint opacity-0 shadow-[0_8px_20px_rgba(0,0,0,0.35)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                          {control.hint}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="min-w-0 font-mono text-[10px] text-faint lg:col-span-3" title={control.id}>
                  <span className="block truncate">{control.id}</span>
                </div>
                <div className="inline-flex items-center gap-1 text-[10px] text-faint lg:col-span-1 lg:justify-self-end lg:pr-1">
                  <Clock3 size={10} /> {ageLabel(control.read_at)}
                </div>
                <div className="lg:col-span-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {control.type === "enum" && control.options?.length ? (
                        <select
                          className="h-7 w-full cursor-pointer appearance-none rounded-card border border-line bg-panel py-1 pl-2 pr-7 text-xs text-text outline-none focus:border-line-hi disabled:cursor-not-allowed disabled:opacity-50"
                          style={{
                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='none' stroke='%235c636c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
                            backgroundRepeat: "no-repeat",
                            backgroundPosition: "right 0.5rem center",
                          }}
                          aria-label={`${control.label} value`}
                          value={value}
                          onChange={(event) => setDraft(control, event.target.value)}
                          disabled={!control.writable}
                        >
                          <option value="">Select…</option>
                          {unknownEnumValue && (
                            <option value={unknownEnumValue}>{unknownEnumValue} - current device value</option>
                          )}
                          {control.options.map((option) => (
                            <option value={option.value} key={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="relative">
                          <input
                            aria-label={`${control.label} value`}
                            className={`h-7 w-full rounded-card border border-line bg-panel px-2 font-mono text-xs text-text outline-none focus:border-line-hi${control.unit ? " pr-7" : ""}`}
                            type={control.type === "number" ? "number" : "text"}
                            min={control.min}
                            max={control.max}
                            step={control.step}
                            value={value}
                            onChange={(event) => setDraft(control, event.target.value)}
                            disabled={!control.writable}
                          />
                          {control.unit && (
                            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-[10px] text-faint">
                              {control.unit}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-start gap-1.5 lg:col-span-2 lg:justify-end">
                  <button
                    className="inline-flex min-h-7 items-center justify-center gap-1 rounded-card border border-line bg-panel-hi px-2.5 text-xs text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45"
                    onClick={() => readOne(control)}
                    disabled={busy}
                    aria-label={`Read ${control.label} from inverter`}
                  >
                    {isReading && <Loader2 size={11} className="animate-spin" />}
                    Read
                  </button>
                  <button
                    className="inline-flex min-h-7 items-center justify-center gap-1 rounded-card border border-line bg-panel-hi px-2.5 text-xs text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45"
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
                    {isWriting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} Send
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
    <div
      className={`grid grid-cols-1 gap-2.5 rounded-card border border-line border-l-2 bg-panel-hi px-2.5 py-2.5 sm:px-3 md:grid-cols-5 md:gap-3 ${eventToneClass[event.status] ?? "border-l-line"}`}
    >
      <div className="font-mono text-xs tabular-nums text-faint md:col-span-1">{eventTime(event)}</div>
      <div className="min-w-0 md:col-span-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs uppercase tracking-widest text-text">{event.action}</span>
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-faint">{event.actor}</span>
          {event.field_id && (
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-xs text-faint">
              {event.field_id}
            </span>
          )}
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-faint">{event.status}</span>
        </div>
        <p className="mt-2 text-xs leading-snug text-dim">{event.reason}</p>
        {(event.value_before != null || event.value_after != null) && (
          <div className="mt-1.5 font-mono text-xs tabular-nums text-faint">
            {event.value_before ?? "—"} → {event.value_after ?? "—"}
          </div>
        )}
      </div>
    </div>
  );
}
