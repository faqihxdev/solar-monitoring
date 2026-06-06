// Fixed operational LiFePO4 guide for the 24V pack. This deliberately avoids
// mode switching because charge/discharge telemetry can be noisy and reboundy.
// Practical 0% is anchored at A4 / recommended low-voltage cutoff.
const PRACTICAL_SOC_EMPTY_V = 22.4;
const PRACTICAL_SOC_FULL_V = 27.2;
const PRACTICAL_SOC_LOGISTIC_K = 1.4;
const PRACTICAL_SOC_LOGISTIC_MIDPOINT_V = 26.35;

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

