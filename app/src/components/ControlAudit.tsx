import { SlidersHorizontal } from "lucide-react";
import type { ControlAuditResponse } from "../api";
import { num } from "../format";

interface Props {
  audit: ControlAuditResponse | undefined;
  loading: boolean;
  error?: unknown;
}

const IMPORTANT = new Set([
  "work_pattern_contlow",
  "charging_gear_setting",
  "bat_charging_current",
  "battery_type_conthigh",
  "bat_low_voltage_protection_value",
  "bat_low_voltage_recovery_value",
  "bat_power_supply_value",
  "bat_mains_power_supply_value",
  "bat_single_battery_float_charge_setting",
  "bat_single_battery_average_charge_setting",
  "lithium_battery_conthigh",
  "lithium_battery_contlow",
]);

function displayValue(entry: ControlAuditResponse["controls"][number]) {
  const base = entry.value == null ? "—" : String(entry.value);
  if (entry.pack_value != null) {
    return `${base}${entry.unit} / pack ${num(entry.pack_value, 1)}${entry.pack_unit}`;
  }
  return `${base}${entry.unit ? ` ${entry.unit}` : ""}`;
}

export default function ControlAudit({ audit, loading, error }: Props) {
  const controls = (audit?.controls ?? []).filter((entry) => IMPORTANT.has(entry.id));
  const message = error
    ? "Control audit endpoint is not available. Restart the API backend."
    : audit?.error
      ? audit.error
      : audit && !controls.length
        ? "No control values returned yet."
        : null;

  return (
    <section className="mt-5.5 animate-[fadein_0.5s_ease_both]">
      <div className="mb-3 flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <h2 className="m-0 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-dim">
          <SlidersHorizontal size={14} strokeWidth={1.8} /> Control audit
        </h2>
        <span className="text-xs tracking-wide text-faint">Read-only values from DESSMonitor Control</span>
      </div>

      <div className="grid grid-cols-5 gap-2.5">
        {loading && !controls.length ? (
          <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
            Reading controls…
          </div>
        ) : message ? (
          <div className="col-span-full rounded-card border border-line bg-panel px-3 py-2.5 text-xs text-faint">
            {message}
          </div>
        ) : (
          controls.map((entry) => (
            <div className="rounded-card border border-line bg-panel px-3 py-2.5" key={entry.id}>
              <div className="min-h-6 text-xs uppercase tracking-wider text-dim">{entry.label}</div>
              <div className="mt-1.5 font-mono tabular-nums text-sm text-text">{displayValue(entry)}</div>
              <div className="mt-1 font-mono text-xs tabular-nums text-faint">{entry.id}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
