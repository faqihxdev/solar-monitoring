export interface BatterySocAnchor {
  voltage: number;
  soc: number;
}

// PowMr "Guide for LiFePO4 Voltage Chart & SOC 12V/24V/48V"
// (26 Aug 2024), using the 24 V / 8-series-cell column. These are open-circuit
// reference voltages, so callers should smooth active-pack telemetry before
// applying the curve.
export const LIFEPO4_24V_SOC_CURVE: readonly BatterySocAnchor[] = [
  { voltage: 20.0, soc: 0.0 },
  { voltage: 20.32, soc: 0.5 },
  { voltage: 22.4, soc: 5.0 },
  { voltage: 24.0, soc: 9.5 },
  { voltage: 24.4, soc: 15.0 },
  { voltage: 25.6, soc: 20.0 },
  { voltage: 25.84, soc: 30.0 },
  { voltage: 26.0, soc: 40.0 },
  { voltage: 26.08, soc: 50.0 },
  { voltage: 26.24, soc: 60.0 },
  { voltage: 26.4, soc: 70.0 },
  { voltage: 26.64, soc: 80.0 },
  { voltage: 26.8, soc: 90.0 },
  { voltage: 27.04, soc: 99.0 },
  { voltage: 27.6, soc: 99.5 },
  { voltage: 29.2, soc: 100.0 },
];

export function socForPackVoltage(voltage: number | null | undefined): number | null {
  if (voltage == null || !Number.isFinite(voltage)) return null;

  const first = LIFEPO4_24V_SOC_CURVE[0];
  const last = LIFEPO4_24V_SOC_CURVE[LIFEPO4_24V_SOC_CURVE.length - 1];
  if (voltage <= first.voltage) return first.soc;
  if (voltage >= last.voltage) return last.soc;

  for (let i = 1; i < LIFEPO4_24V_SOC_CURVE.length; i += 1) {
    const upper = LIFEPO4_24V_SOC_CURVE[i];
    if (voltage > upper.voltage) continue;
    const lower = LIFEPO4_24V_SOC_CURVE[i - 1];
    const fraction = (voltage - lower.voltage) / (upper.voltage - lower.voltage);
    return lower.soc + fraction * (upper.soc - lower.soc);
  }

  return last.soc;
}

export function packVoltageForSoc(soc: number | null | undefined): number | null {
  if (soc == null || !Number.isFinite(soc)) return null;

  const first = LIFEPO4_24V_SOC_CURVE[0];
  const last = LIFEPO4_24V_SOC_CURVE[LIFEPO4_24V_SOC_CURVE.length - 1];
  if (soc <= first.soc) return first.voltage;
  if (soc >= last.soc) return last.voltage;

  for (let i = 1; i < LIFEPO4_24V_SOC_CURVE.length; i += 1) {
    const upper = LIFEPO4_24V_SOC_CURVE[i];
    if (soc > upper.soc) continue;
    const lower = LIFEPO4_24V_SOC_CURVE[i - 1];
    const fraction = (soc - lower.soc) / (upper.soc - lower.soc);
    return lower.voltage + fraction * (upper.voltage - lower.voltage);
  }

  return last.voltage;
}
