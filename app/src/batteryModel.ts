import type { Reading, ThresholdEntry } from "./api";
import { isOnMains } from "./format";
import {
  LIFEPO4_24V_SOC_CURVE,
  packVoltageForSoc,
  socForPackVoltage,
  type BatterySocAnchor,
} from "../shared/batterySocCurve";

const A6_ID = "a6_return_pln";
const A7_ID = "a7_switch_pln";
const A5_ID = "a5_low_recovery";
const A4_ID = "a4_low_protection";

export interface BatteryThresholds {
  a6: number | null;
  a7: number | null;
  a5: number | null;
  a4: number | null;
}

export interface PracticalBattery {
  voltage: number | null;
  reportedSoc: number | null;
  practicalSocPct: number | null;
  a7BufferPct: number | null;
  a4ReservePct: number | null;
  stateLabel: string;
  reportedSocLabel: string;
  practicalSocLabel: string;
  bufferLabel: string;
}

export interface PracticalEta {
  label: string;
  targetId: "A6" | "A7";
  targetVoltage: number;
  targetSoc: number;
  slopePctPerHour: number;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function thresholdValue(thresholds: ThresholdEntry[], id: string): number | null {
  return thresholds.find((t) => t.id === id)?.value ?? null;
}

export type PracticalSocAnchor = BatterySocAnchor;

export function practicalSocAnchors(): PracticalSocAnchor[] {
  return LIFEPO4_24V_SOC_CURVE.map((anchor) => ({ ...anchor }));
}

export function batteryThresholds(thresholds: ThresholdEntry[]): BatteryThresholds {
  return {
    a6: thresholdValue(thresholds, A6_ID),
    a7: thresholdValue(thresholds, A7_ID),
    a5: thresholdValue(thresholds, A5_ID),
    a4: thresholdValue(thresholds, A4_ID),
  };
}

export function practicalBufferPct(
  voltage: number | null | undefined,
  thresholds: ThresholdEntry[]
): number | null {
  const { a6, a7 } = batteryThresholds(thresholds);
  if (voltage == null || a6 == null || a7 == null || a6 <= a7) return null;
  return clampPct(((voltage - a7) / (a6 - a7)) * 100);
}

export function protectionReservePct(
  voltage: number | null | undefined,
  thresholds: ThresholdEntry[]
): number | null {
  const { a7, a4 } = batteryThresholds(thresholds);
  if (voltage == null || a7 == null || a4 == null || a7 <= a4) return null;
  return clampPct(((voltage - a4) / (a7 - a4)) * 100);
}

export function practicalSocPct(voltage: number | null | undefined): number | null {
  return socForPackVoltage(voltage);
}

// Trailing window used to smooth the *displayed* practical SOC. Because the
// curve is steep across the operating plateau, raw 0.2V quantization steps and
// brief load-sag transients translate into visible % jumps. We smooth the
// voltage (the physical input) before the nonlinear mapping using a MEAN: a
// median just re-picks one of the discrete 0.2V steps (so it still snaps),
// whereas the mean lands between steps (e.g. 25.5V) and maps to a smooth %.
// Over a 15-min window a momentary load-sag sample is a small fraction of the
// average, so the mean stays robust as well.
export const PRACTICAL_SOC_SMOOTHING_MINUTES = 15;

export interface VoltageSamplePoint {
  t: number;
  v: number | null | undefined;
}

export function meanVoltage(
  samples: ReadonlyArray<VoltageSamplePoint>,
  anchorSec: number | null | undefined,
  windowMinutes: number = PRACTICAL_SOC_SMOOTHING_MINUTES
): number | null {
  let anchor = anchorSec ?? null;
  if (anchor == null) {
    for (const s of samples) {
      if (s.v != null && Number.isFinite(s.v)) anchor = s.t;
    }
  }
  if (anchor == null) return null;
  const cutoff = anchor - windowMinutes * 60;
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    if (s.t < cutoff || s.t > anchor + 120) continue;
    if (s.v == null || !Number.isFinite(s.v)) continue;
    sum += s.v;
    count += 1;
  }
  if (!count) return null;
  return sum / count;
}

export function voltageForPracticalSoc(soc: number | null | undefined): number | null {
  return packVoltageForSoc(soc);
}

export function practicalBattery(
  reading: Pick<Reading, "battery_voltage" | "battery_soc" | "working_state"> | null | undefined,
  thresholds: ThresholdEntry[]
): PracticalBattery {
  const voltage = reading?.battery_voltage ?? null;
  const reportedSoc = reading?.battery_soc ?? null;
  const practicalSoc = practicalSocPct(voltage);
  const a7BufferPct = practicalBufferPct(voltage, thresholds);
  const a4ReservePct = protectionReservePct(voltage, thresholds);
  const { a6, a7, a4 } = batteryThresholds(thresholds);

  let stateLabel = "Voltage unknown";
  if (voltage != null) {
    if (a4 != null && voltage <= a4) stateLabel = "At protection floor";
    else if (a7 != null && voltage <= a7) stateLabel = "At A7 mains point";
    else if (a6 != null && voltage < a6) stateLabel = "Below return target";
    else stateLabel = "Above return target";
  }

  return {
    voltage,
    reportedSoc,
    practicalSocPct: practicalSoc,
    a7BufferPct,
    a4ReservePct,
    stateLabel,
    reportedSocLabel: reportedSoc == null ? "Reported SOC --" : `Reported ${Math.round(reportedSoc)}%`,
    practicalSocLabel:
      practicalSoc == null ? "Practical SOC --" : `Practical ${Math.round(practicalSoc)}%`,
    bufferLabel:
      a7BufferPct == null ? "A7 buffer --" : `A7 buffer ${Math.round(a7BufferPct)}%`,
  };
}

function fitPracticalSocSlope(points: Reading[]): number | null {
  const rows = points
    .map((p) => ({ polled_at: p.polled_at, practical_soc: practicalSocPct(p.battery_voltage) }))
    .filter((p): p is { polled_at: number; practical_soc: number } => p.practical_soc != null);
  if (rows.length < 4) return null;
  const t0 = rows[0].polled_at;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of rows) {
    const x = (p.polled_at - t0) / 3600;
    const y = p.practical_soc;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = rows.length;
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) return null;
  return (n * sxy - sx * sy) / den;
}

function formatDuration(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  if (totalMinutes >= 72 * 60) return "72h+";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function estimatePracticalEta(
  history: Reading[],
  latest: Reading | null | undefined,
  thresholds: ThresholdEntry[]
): PracticalEta | null {
  // Use the same trailing mean voltage as the gauge so the ETA's starting
  // SOC doesn't jump with the 0.2V quantization steps.
  const smoothed = meanVoltage(
    [
      ...history.map((p) => ({ t: p.polled_at, v: p.battery_voltage })),
      ...(latest?.battery_voltage != null && latest?.polled_at != null
        ? [{ t: latest.polled_at, v: latest.battery_voltage }]
        : []),
    ],
    latest?.polled_at,
  );
  const voltage = smoothed ?? latest?.battery_voltage ?? null;
  const { a6, a7 } = batteryThresholds(thresholds);
  if (voltage == null || a6 == null || a7 == null || history.length < 4) return null;
  const practicalSoc = practicalSocPct(voltage);
  if (practicalSoc == null) return null;

  const onMains = isOnMains(latest?.working_state);
  const discharging = latest?.battery_status === 1 && !onMains;
  const recovering = (latest?.battery_status === -1 || onMains) && voltage < a6;
  const target = discharging ? a7 : recovering ? a6 : null;
  const targetId = discharging ? "A7" : recovering ? "A6" : null;
  if (target == null || targetId == null) return null;
  const targetSoc = practicalSocPct(target);
  if (targetSoc == null) return null;

  const now = history[history.length - 1]?.polled_at ?? latest?.polled_at;
  if (now == null) return null;

  const windows = [
    { seconds: 45 * 60, minAbsSlope: 2.0 },
    { seconds: 2 * 3600, minAbsSlope: 1.0 },
    { seconds: 6 * 3600, minAbsSlope: 0.5 },
  ];

  for (const window of windows) {
    const pts = history.filter((p) => {
      if (p.polled_at < now - window.seconds || p.battery_voltage == null) return false;
      if (discharging) return p.battery_status === 1 && !isOnMains(p.working_state);
      if (recovering) return p.battery_status === -1 || isOnMains(p.working_state);
      return false;
    });
    const slope = fitPracticalSocSlope(pts);
    if (slope == null || Math.abs(slope) < window.minAbsSlope) continue;
    if (discharging && slope >= 0) continue;
    if (recovering && slope <= 0) continue;

    const hours = discharging ? (practicalSoc - targetSoc) / -slope : (targetSoc - practicalSoc) / slope;
    if (!Number.isFinite(hours) || hours < 0) continue;
    return {
      label: `~${formatDuration(hours)} to ${targetId} (${Math.round(targetSoc)}%)`,
      targetId,
      targetVoltage: target,
      targetSoc,
      slopePctPerHour: slope,
    };
  }

  return null;
}
