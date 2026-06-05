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

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
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

