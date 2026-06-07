export function num(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(digits);
}

// Power as W when small, kW otherwise. Input is in kW.
export function powerKw(kw: number | null | undefined): { value: string; unit: string } {
  if (kw == null || Number.isNaN(kw)) return { value: "—", unit: "" };
  const abs = Math.abs(kw);
  if (abs < 1) return { value: Math.round(kw * 1000).toString(), unit: "W" };
  return { value: kw.toFixed(2), unit: "kW" };
}

export function watts(w: number | null | undefined): { value: string; unit: string } {
  if (w == null || Number.isNaN(w)) return { value: "—", unit: "" };
  const abs = Math.abs(w);
  if (abs >= 1000) return { value: (w / 1000).toFixed(2), unit: "kW" };
  return { value: Math.round(w).toString(), unit: "W" };
}

export function relativeAge(ageMs: number): string {
  const sec = Math.max(0, Math.round(ageMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

export const DISPLAY_TIME_ZONE = "Asia/Jakarta";
export const DISPLAY_TIME_LABEL = "GMT+7";

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

export function fullTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

export function todayJkt(): string {
  return new Date().toLocaleDateString("sv", { timeZone: DISPLAY_TIME_ZONE });
}

export type RangeKey = "6h" | "12h" | "1d" | "3d" | "1w" | "today";

// Jakarta is UTC+7 with no DST — safe to use fixed offset.
export function jakartaMidnightMs(): number {
  const dateStr = new Date().toLocaleDateString("sv", { timeZone: DISPLAY_TIME_ZONE });
  return Date.parse(`${dateStr}T00:00:00+07:00`);
}

export function offsetDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function jakartaMidnightMsForDate(date: string): number {
  return Date.parse(`${date}T00:00:00+07:00`);
}

export function formatDayShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function hoursForRange(range: RangeKey): number {
  if (range === "today") {
    const elapsed = (Date.now() - jakartaMidnightMs()) / (3600 * 1000);
    // Ceiling to whole hours for cache-key stability; at least 1h so chart isn't empty.
    return Math.max(1, Math.ceil(elapsed));
  }
  const map: Record<string, number> = { "6h": 6, "12h": 12, "1d": 24, "3d": 72, "1w": 168 };
  return map[range] ?? 6;
}

export function isOnMains(workingState: string | null | undefined): boolean {
  if (!workingState) return false;
  const s = workingState.toLowerCase();
  return (
    s.includes("mains") ||
    s.includes("grid") ||
    s.includes("utility") ||
    s.includes("on-line") ||
    s.includes("online")
  );
}
