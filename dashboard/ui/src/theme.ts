// Flat, solid colors only — no gradients anywhere in the product.
export const C = {
  bg: "#0c0e10",
  panel: "#15181b",
  panelHi: "#1b1f23",
  line: "#23282d",
  lineHi: "#323840",
  text: "#dfe3e7",
  textDim: "#8b929b",
  textFaint: "#5c636c",

  solar: "#e6b422",
  charge: "#4eb45a",
  discharge: "#e8743b",
  grid: "#4a93c4",
  load: "#c8ccd2",
  battery: "#9c7bd4",

  ok: "#4eb45a",
  warn: "#e6b422",
  bad: "#e0533d",
} as const;

// Literal font stacks for use in SVG attributes, where CSS var() does not resolve.
export const FONT = {
  mono: '"IBM Plex Mono", ui-monospace, monospace',
  display: '"Inter", system-ui, sans-serif',
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
