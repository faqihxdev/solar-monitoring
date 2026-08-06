import { packVoltageForSoc, socForPackVoltage } from "../shared/batterySocCurve";

export function practicalSocPct(voltage: number | null | undefined): number | null {
  return socForPackVoltage(voltage);
}

// Trailing window used to smooth the practical SOC input voltage. See
// app/src/batteryModel.ts for the rationale; keep both in sync.
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

