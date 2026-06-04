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
    <section className="section fade-in">
      <div className="section-head">
        <h2>
          <SlidersHorizontal size={14} strokeWidth={1.8} /> Control audit
        </h2>
        <span className="note">Read-only values from DESSMonitor Control</span>
      </div>

      <div className="audit-grid">
        {loading && !controls.length ? (
          <div className="audit-card audit-card--muted">Reading controls…</div>
        ) : message ? (
          <div className="audit-card audit-card--muted">{message}</div>
        ) : (
          controls.map((entry) => (
            <div className="audit-card" key={entry.id}>
              <div className="audit-card__label">{entry.label}</div>
              <div className="audit-card__value mono">{displayValue(entry)}</div>
              <div className="audit-card__id mono">{entry.id}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
