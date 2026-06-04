import type { Reading, ThresholdEntry } from "./api";
import { isOnMains, num } from "./format";

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

export interface VoltageEta {
  label: string;
  targetId: "A6" | "A7";
  targetVoltage: number;
  slopeVPerHour: number;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function thresholdValue(thresholds: ThresholdEntry[], id: string): number | null {
  return thresholds.find((t) => t.id === id)?.value ?? null;
}

const PRACTICAL_SOC_CURVE: Array<[number, number]> = [
  [22.4, 0],
  [23.4, 5],
  [23.8, 8],
  [24.0, 11],
  [24.4, 16],
  [24.6, 20],
  [24.8, 25],
  [25.2, 38],
  [25.6, 52],
  [25.8, 58],
  [26.0, 65],
  [26.4, 80],
  [26.8, 92],
  [27.2, 100],
];

export interface PracticalSocAnchor {
  voltage: number;
  soc: number;
}

export function practicalSocAnchors(): PracticalSocAnchor[] {
  return PRACTICAL_SOC_CURVE.map(([voltage, soc]) => ({ voltage, soc }));
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
  if (voltage == null) return null;
  if (voltage <= PRACTICAL_SOC_CURVE[0][0]) return PRACTICAL_SOC_CURVE[0][1];
  const last = PRACTICAL_SOC_CURVE[PRACTICAL_SOC_CURVE.length - 1];
  if (voltage >= last[0]) return last[1];

  for (let i = 1; i < PRACTICAL_SOC_CURVE.length; i += 1) {
    const [vHi, socHi] = PRACTICAL_SOC_CURVE[i];
    const [vLo, socLo] = PRACTICAL_SOC_CURVE[i - 1];
    if (voltage <= vHi) {
      const t = (voltage - vLo) / (vHi - vLo);
      return clampPct(socLo + t * (socHi - socLo));
    }
  }
  return null;
}

export function voltageForPracticalSoc(soc: number | null | undefined): number | null {
  if (soc == null) return null;
  const targetSoc = clampPct(soc);
  const first = PRACTICAL_SOC_CURVE[0];
  const last = PRACTICAL_SOC_CURVE[PRACTICAL_SOC_CURVE.length - 1];
  if (targetSoc <= first[1]) return first[0];
  if (targetSoc >= last[1]) return last[0];

  for (let i = 1; i < PRACTICAL_SOC_CURVE.length; i += 1) {
    const [vHi, socHi] = PRACTICAL_SOC_CURVE[i];
    const [vLo, socLo] = PRACTICAL_SOC_CURVE[i - 1];
    if (targetSoc <= socHi) {
      const t = (targetSoc - socLo) / (socHi - socLo);
      return vLo + t * (vHi - vLo);
    }
  }
  return null;
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

function fitVoltageSlope(points: Reading[]): number | null {
  const rows = points.filter((p) => p.battery_voltage != null);
  if (rows.length < 4) return null;
  const t0 = rows[0].polled_at;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of rows) {
    const x = (p.polled_at - t0) / 3600;
    const y = p.battery_voltage as number;
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

export function estimateVoltageEta(
  history: Reading[],
  latest: Reading | null | undefined,
  thresholds: ThresholdEntry[]
): VoltageEta | null {
  const voltage = latest?.battery_voltage ?? null;
  const { a6, a7 } = batteryThresholds(thresholds);
  if (voltage == null || a6 == null || a7 == null || history.length < 4) return null;

  const onMains = isOnMains(latest?.working_state);
  const discharging = latest?.battery_status === 1 && !onMains;
  const recovering = (latest?.battery_status === -1 || onMains) && voltage < a6;
  const target = discharging ? a7 : recovering ? a6 : null;
  const targetId = discharging ? "A7" : recovering ? "A6" : null;
  if (target == null || targetId == null) return null;

  const now = history[history.length - 1]?.polled_at ?? latest?.polled_at;
  if (now == null) return null;

  const windows = [
    { seconds: 45 * 60, minAbsSlope: 0.08 },
    { seconds: 2 * 3600, minAbsSlope: 0.04 },
    { seconds: 6 * 3600, minAbsSlope: 0.025 },
  ];

  for (const window of windows) {
    const pts = history.filter((p) => {
      if (p.polled_at < now - window.seconds || p.battery_voltage == null) return false;
      if (discharging) return p.battery_status === 1 && !isOnMains(p.working_state);
      if (recovering) return p.battery_status === -1 || isOnMains(p.working_state);
      return false;
    });
    const slope = fitVoltageSlope(pts);
    if (slope == null || Math.abs(slope) < window.minAbsSlope) continue;
    if (discharging && slope >= 0) continue;
    if (recovering && slope <= 0) continue;

    const hours = discharging ? (voltage - target) / -slope : (target - voltage) / slope;
    if (!Number.isFinite(hours) || hours < 0) continue;
    return {
      label: `~${formatDuration(hours)} to ${targetId} (${num(target, 1)}V)`,
      targetId,
      targetVoltage: target,
      slopeVPerHour: slope,
    };
  }

  return null;
}
