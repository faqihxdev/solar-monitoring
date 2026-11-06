import { createContext, useContext } from "react";
import type { ConfigResponse } from "./api";
import {
  LIFEPO4_24V_SOC_CURVE,
  type BatterySocAnchor,
} from "../shared/batterySocCurve";

// What the dashboard needs to know about the inverter the backend was built for.
export interface InverterProfile {
  id: string;
  name: string;
  writes: boolean;
  automation: boolean;
  socCurve: readonly BatterySocAnchor[];
  // Names for the point where loads switch to the grid and where they return to battery.
  switchName: string;
  returnName: string;
  switchPoint: string;
  bufferName: string;
  // Short chart labels, keyed by threshold id.
  thresholdShort: Record<string, string>;
}

type Terms = Pick<
  InverterProfile,
  "switchName" | "returnName" | "switchPoint" | "bufferName" | "thresholdShort"
>;

const DESS_TERMS: Terms = {
  switchName: "A7",
  returnName: "A6",
  switchPoint: "A7 mains point",
  bufferName: "A7 buffer",
  thresholdShort: {
    soc_to_mains: "SOC GRID",
    soc_resume_inverter: "SOC INV",
    a3_float_charge: "A3 FLT",
    a7_switch_pln: "A7 GRID",
    a6_return_pln: "A6 INV",
    a5_low_recovery: "A5 REC",
    a4_low_protection: "A4 CUT",
  },
};
const GENERIC_TERMS: Terms = {
  switchName: "grid switch",
  returnName: "battery return",
  switchPoint: "grid switch point",
  bufferName: "Grid buffer",
  thresholdShort: {
    a3_float_charge: "FLOAT",
    a7_switch_pln: "GRID",
    a6_return_pln: "BATT",
    a5_low_recovery: "RECOVER",
    a4_low_protection: "CUTOFF",
  },
};

// Servers that predate profiles (the TypeScript backend) are PowMr builds.
export const POWMR_PROFILE: InverterProfile = {
  id: "dess",
  name: "PowMr via DESSMonitor",
  writes: true,
  automation: true,
  socCurve: LIFEPO4_24V_SOC_CURVE,
  ...DESS_TERMS,
};
// Until the config arrives: no curve, so charge shows as unknown instead of a wrong guess.
export const UNKNOWN_PROFILE: InverterProfile = {
  id: "unknown",
  name: "Inverter",
  writes: false,
  automation: false,
  socCurve: [],
  ...GENERIC_TERMS,
};

export function inverterProfile(
  config: ConfigResponse | undefined,
): InverterProfile {
  if (!config) return UNKNOWN_PROFILE;
  const profile = config.inverter;
  if (!profile) return POWMR_PROFILE;
  return {
    id: profile.id,
    name: profile.name,
    writes: profile.writes,
    automation: profile.automation,
    socCurve: profile.soc_curve.map(([voltage, soc]) => ({ voltage, soc })),
    ...(profile.id === "dess" ? DESS_TERMS : GENERIC_TERMS),
  };
}

export const InverterContext = createContext<InverterProfile>(UNKNOWN_PROFILE);

export function useInverter(): InverterProfile {
  return useContext(InverterContext);
}
