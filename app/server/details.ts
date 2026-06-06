type JsonRow = Record<string, unknown>;

function parseFieldRow(fieldRow: unknown): unknown[] {
  if (typeof fieldRow === "string") return JSON.parse(fieldRow) as unknown[];
  if (Array.isArray(fieldRow)) return fieldRow;
  throw new TypeError(`unexpected field row type: ${typeof fieldRow}`);
}

function indexByTitle(titleRows: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  titleRows.forEach((item, idx) => {
    if (item && typeof item === "object") {
      const title = String((item as JsonRow).title ?? "").trim().toLowerCase();
      result[title] = idx;
    }
  });
  return result;
}

function valueAt(fields: unknown[], index: number | undefined): unknown {
  if (index == null || index < 0 || index >= fields.length) return null;
  return fields[index];
}

function parseNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text || text === "--") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms = "0"] = match;
  const utcMs =
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms.padEnd(3, "0").slice(0, 3)),
    ) -
    7 * 3600 * 1000; // DESS Details timestamps are device wall-time at GMT+7.
  return utcMs / 1000;
}

export interface VoltageSample {
  sampled_at: number;
  sampled_at_raw: string;
  battery_voltage: number;
  mppt_battery_voltage: number | null;
  working_state: string | null;
  battery_soc: number | null;
}

export function parseDetailsDat(dat: JsonRow): VoltageSample[] {
  const titleRows = Array.isArray(dat.title) ? dat.title : [];
  const rows = Array.isArray(dat.row) ? dat.row : [];
  if (!titleRows.length || !rows.length) return [];

  const byTitle = indexByTitle(titleRows);
  const tsIdx = byTitle.timestamp;
  const batIdx = byTitle["battery voltage"];
  const mpptIdx = byTitle["mppt battery voltage"];
  const stateIdx = byTitle["working state"];
  const socIdx = byTitle["bms lithium battery capacity soc"];
  const samples: VoltageSample[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let fields: unknown[];
    try {
      fields = parseFieldRow((row as JsonRow).field);
    } catch {
      continue;
    }

    const rawTimestamp = valueAt(fields, tsIdx);
    const sampledAt = parseTimestamp(rawTimestamp);
    const batteryVoltage = parseNumber(valueAt(fields, batIdx));
    if (sampledAt == null || batteryVoltage == null) continue;

    const workingState = valueAt(fields, stateIdx);
    const stateText = workingState == null ? "" : String(workingState).trim();
    samples.push({
      sampled_at: sampledAt,
      sampled_at_raw: String(rawTimestamp).trim(),
      battery_voltage: batteryVoltage,
      mppt_battery_voltage: parseNumber(valueAt(fields, mpptIdx)),
      working_state: stateText && stateText !== "--" ? stateText : null,
      battery_soc: parseNumber(valueAt(fields, socIdx)),
    });
  }

  return samples;
}
