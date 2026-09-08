// Match the semantic CSS tokens in tailwind.css. Surfaces are strictly neutral.
export const C = {
  bg: "#080808",
  panel: "#101010",
  panelHi: "#181818",
  line: "#292929",
  lineHi: "#404040",
  text: "#ededed",
  textDim: "#a3a3a3",
  textFaint: "#858585",

  solar: "#e6b422",
  charge: "#4eb45a",
  discharge: "#e8743b",
  grid: "#4a93c4",
  load: "#12c8bd",
  battery: "#9c7bd4",

  ok: "#4eb45a",
  warn: "#e6b422",
  bad: "#e39189",
} as const;

// Literal font stacks for use in SVG attributes, where CSS var() does not resolve.
export const FONT = {
  mono: '"Geist Mono", ui-monospace, monospace',
  display: '"Geist", system-ui, sans-serif',
} as const;

export const STATUS = {
  charge: -1,
  idle: 0,
  discharge: 1,
} as const;

export function statusColor(status: number | null | undefined): string {
  if (status === -1) return C.charge;
  if (status === 1) return C.discharge;
  return C.textFaint;
}

export function statusLabel(status: number | null | undefined): string {
  if (status === -1) return "Charging";
  if (status === 1) return "Discharging";
  if (status === 0) return "Idle";
  return "Unknown";
}

export function statusShort(status: number | null | undefined): string {
  if (status === -1) return "CHG";
  if (status === 1) return "DSG";
  if (status === 0) return "IDLE";
  return "—";
}
