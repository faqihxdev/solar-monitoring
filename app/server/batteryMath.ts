// Fixed operational LiFePO4 guide for the 24V pack. This deliberately avoids
// mode switching because charge/discharge telemetry can be noisy and reboundy.
// Practical 0% is anchored at A4 / recommended low-voltage cutoff.
//
// The logistic midpoint is the steep ("near-vertical" on a SOC-vs-voltage plot)
// part of the curve and must sit on the real discharge plateau. Measured from
// ~3 days of battery-only discharge telemetry, ~65% of delivered energy lives
// between 25.0-26.0V (center ~25.4V), with fast surface-charge drop above
// ~26.2V and a fast knee below ~24.8V. The midpoint is therefore anchored at
// 25.4V rather than the cell-resting ~26.35V.
//
// Keep these constants in sync with app/src/batteryModel.ts.
const PRACTICAL_SOC_EMPTY_V = 22.4;
const PRACTICAL_SOC_FULL_V = 27.2;
const PRACTICAL_SOC_LOGISTIC_K = 1.4;
const PRACTICAL_SOC_LOGISTIC_MIDPOINT_V = 25.4;

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function rawPracticalSoc(voltage: number): number {
  return sigmoid(PRACTICAL_SOC_LOGISTIC_K * (voltage - PRACTICAL_SOC_LOGISTIC_MIDPOINT_V));
}

export function practicalSocPct(voltage: number | null | undefined): number | null {
  if (voltage == null) return null;
  if (voltage <= PRACTICAL_SOC_EMPTY_V) return 0;
  if (voltage >= PRACTICAL_SOC_FULL_V) return 100;

  const empty = rawPracticalSoc(PRACTICAL_SOC_EMPTY_V);
  const full = rawPracticalSoc(PRACTICAL_SOC_FULL_V);
  return clampPct(((rawPracticalSoc(voltage) - empty) / (full - empty)) * 100);
}

// Trailing window used to smooth the practical SOC input voltage. See
// app/src/batteryModel.ts for the rationale; keep both in sync.
export const PRACTICAL_SOC_SMOOTHING_MINUTES = 15;

export interface VoltageSamplePoint {
  t: number;
  v: number | null | undefined;
}

export function medianVoltage(
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
  const vals: number[] = [];
  for (const s of samples) {
    if (s.t < cutoff || s.t > anchor + 120) continue;
    if (s.v == null || !Number.isFinite(s.v)) continue;
    vals.push(s.v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

export function voltageForPracticalSoc(soc: number | null | undefined): number | null {
  if (soc == null) return null;
  const targetSoc = clampPct(soc);
  if (targetSoc <= 0) return PRACTICAL_SOC_EMPTY_V;
  if (targetSoc >= 100) return PRACTICAL_SOC_FULL_V;

  let lo = PRACTICAL_SOC_EMPTY_V;
  let hi = PRACTICAL_SOC_FULL_V;
  for (let i = 0; i < 32; i += 1) {
    const mid = (lo + hi) / 2;
    const midSoc = practicalSocPct(mid) ?? 0;
    if (midSoc < targetSoc) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

