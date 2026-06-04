import { Battery } from "lucide-react";
import type { Reading, Summary, ThresholdEntry } from "../api";
import { estimateVoltageEta, practicalBattery } from "../batteryModel";
import { num } from "../format";
import { C, statusColor, statusLabel } from "../theme";

interface Props {
  latest: Reading | null;
  summary: Summary | null;
  socThresholds: ThresholdEntry[];
  voltageThresholds: ThresholdEntry[];
  history: Reading[];
}

const CX = 120;
const CY = 122;
const R = 96;

function polar(theta: number) {
  const a = (theta * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
}

function thetaForPct(pct: number) {
  return 180 * (1 - Math.min(100, Math.max(0, pct)) / 100);
}

function arcPath(startTheta: number, endTheta: number) {
  const s = polar(startTheta);
  const e = polar(endTheta);
  const large = Math.abs(startTheta - endTheta) > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

export default function BatteryPanel({
  latest,
  summary,
  socThresholds,
  voltageThresholds,
  history,
}: Props) {
  const status = latest?.battery_status ?? 0;
  const color = statusColor(status);
  const practical = practicalBattery(latest, voltageThresholds);

  const switchT = socThresholds.find((t) => t.id === "soc_to_mains");
  const eta = estimateVoltageEta(history, latest, voltageThresholds);
  const gaugePct = practical.practicalSocPct;

  const valueArc =
    gaugePct != null ? arcPath(180, thetaForPct(gaugePct)) : null;
  const dangerArc =
    switchT != null ? arcPath(180, thetaForPct(15)) : null;

  return (
    <div className="panel battery fade-in">
      <div className="panel__label">
        <Battery size={14} strokeWidth={1.8} /> Battery
      </div>

      <div className="gauge-wrap">
        <svg viewBox="0 0 240 150" className="gauge-svg" width="100%">
          {/* track */}
          <path
            d={arcPath(180, 0)}
            stroke={C.line}
            strokeWidth={14}
            fill="none"
            strokeLinecap="round"
          />
          {/* danger zone below switch-to-grid */}
          {dangerArc && (
            <path
              d={dangerArc}
              stroke={C.bad}
              strokeOpacity={0.32}
              strokeWidth={14}
              fill="none"
              strokeLinecap="round"
            />
          )}
          {/* value */}
          {valueArc && (
            <path
              d={valueArc}
              stroke={color}
              strokeWidth={14}
              fill="none"
              strokeLinecap="round"
            />
          )}
        </svg>
        <div className="gauge-center">
          <div className="gauge-soc mono" style={{ color }}>
            {gaugePct != null ? Math.round(gaugePct) : "—"}
            <small>%</small>
          </div>
          <div className="gauge-state" style={{ color }}>
            Practical SOC · {statusLabel(status)}
          </div>
        </div>
      </div>

      <div className="batt-meta">
        <div className="batt-meta__cell">
          <div className="batt-meta__k">Pack voltage</div>
          <div className="batt-meta__v mono">
            {latest?.battery_voltage != null ? num(latest.battery_voltage, 1) : "—"}{" "}
            <small>V</small>
          </div>
        </div>
        <div className="batt-meta__cell">
          <div className="batt-meta__k">{eta ? "Voltage ETA" : "Reported SOC"}</div>
          <div className="batt-meta__v mono">
            {eta ? (
              <span style={{ fontSize: 15 }}>{eta.label}</span>
            ) : latest?.battery_soc != null ? (
              <>
                {Math.round(latest.battery_soc)} <small>%</small>
              </>
            ) : summary?.soc_min != null && summary?.soc_max != null ? (
              <>
                {Math.round(summary.soc_min)}–{Math.round(summary.soc_max)} <small>%</small>
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
