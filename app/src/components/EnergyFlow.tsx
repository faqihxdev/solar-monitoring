import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Battery,
  Box,
  Cable,
  ChevronRight,
  CircuitBoard,
  Home,
  Pause,
  Play,
  Sun,
  UtilityPole,
} from "lucide-react";
import type { Reading, ThresholdEntry } from "../api";
import {
  batteryThresholds,
  estimatePracticalEta,
  meanVoltage,
  practicalBattery,
} from "../batteryModel";
import { deriveFlows } from "../energy";
import {
  DEVICE_NAMES,
  energyConnections,
  powerLabel,
  type DeviceId,
} from "../energyViewModel";
import { num } from "../format";
import { C, statusLabel } from "../theme";
import { IconButton } from "./ui";

const EnergyScene = lazy(() => import("./EnergyScene"));
const DEVICE_ICONS = {
  solar: Sun,
  inverter: CircuitBoard,
  battery: Battery,
  home: Home,
  grid: UtilityPole,
};

interface Props {
  latest: Reading | null;
  voltageThresholds: ThresholdEntry[];
  history: Reading[];
  loadMaxKw: number | null;
  fresh: boolean;
}

function Sparkline({
  values,
  color,
}: {
  values: (number | null)[];
  color: string;
}) {
  const points = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (points.length < 2) return <span className="sparkline-empty" />;
  const min = Math.min(...points),
    max = Math.max(...points),
    span = Math.max(max - min, 0.01);
  const line = points
    .map(
      (v, i) =>
        `${(i / (points.length - 1)) * 96},${29 - ((v - min) / span) * 24}`,
    )
    .join(" ");
  return (
    <svg viewBox="0 0 96 34" className="sparkline" aria-hidden="true">
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function EnergyFlow({
  latest,
  voltageThresholds,
  history,
  loadMaxKw,
  fresh,
}: Props) {
  const [selected, setSelected] = useState<DeviceId>("battery");
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [showConnections, setShowConnections] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const f = deriveFlows(latest);
  const connections = useMemo(() => energyConnections(latest), [latest]);
  const batteryConnection = connections.find((c) => c.id === "battery")!;
  const gridConnection = connections.find((c) => c.id === "grid")!;
  const mean = useMemo(
    () =>
      meanVoltage(
        [
          ...history.map((r) => ({ t: r.polled_at, v: r.battery_voltage })),
          ...(latest
            ? [{ t: latest.polled_at, v: latest.battery_voltage }]
            : []),
        ],
        latest?.polled_at,
      ),
    [history, latest],
  );
  const practical = practicalBattery(
    latest && mean != null ? { ...latest, battery_voltage: mean } : latest,
    voltageThresholds,
  );
  const eta = useMemo(
    () => estimatePracticalEta(history, latest, voltageThresholds),
    [history, latest, voltageThresholds],
  );
  const thresholds = batteryThresholds(voltageThresholds);
  const gridVoltage = latest?.grid_voltage;
  const gridStatus =
    gridVoltage == null
      ? "Voltage unknown"
      : gridVoltage < 50
        ? "Grid unavailable"
        : f.gridKw < -0.01
          ? "Exporting"
          : f.onMains
            ? "Supplying home"
            : "Standby";
  const batteryStatus = statusLabel(latest?.battery_status);
  const recent = history.slice(-80);
  const metrics = [
    {
      id: "solar",
      label: "Solar generation",
      value: powerLabel(
        latest?.pv_power == null ? null : latest.pv_power / 1000,
      ),
      caption: "",
      icon: Sun,
      color: C.solar,
      values: recent.map((r) => r.pv_power),
    },
    {
      id: "home",
      label: "Home consumption",
      value: powerLabel(latest?.load_power),
      caption:
        loadMaxKw && latest?.load_power != null
          ? `${Math.round((f.loadKw / loadMaxKw) * 100)}% of rated output`
          : "",
      icon: Home,
      color: C.load,
      values: recent.map((r) => r.load_power),
    },
    {
      id: "battery",
      label: "Battery reserve",
      value:
        practical.practicalSocPct == null
          ? "—"
          : `${Math.round(practical.practicalSocPct)} %`,
      caption: `${batteryStatus} / ${num(latest?.battery_voltage, 1)} V`,
      icon: Battery,
      color: C.battery,
      values: recent.map((r) => r.battery_voltage),
    },
    {
      id: "grid",
      label: "Grid / PLN",
      value: gridConnection.value,
      caption: gridStatus,
      icon: UtilityPole,
      color: C.grid,
      values: recent.map((r) => r.grid_power_effective ?? r.grid_power),
    },
  ] as const;
  const Icon = DEVICE_ICONS[selected];
  const details: Record<
    DeviceId,
    {
      subtitle: string;
      value: string;
      unitLabel: string;
      rows: [string, string][];
      note?: string;
    }
  > = {
    battery: {
      subtitle: batteryStatus,
      value:
        practical.practicalSocPct == null
          ? "—"
          : `${Math.round(practical.practicalSocPct)}%`,
      unitLabel: "Practical state of charge",
      rows: [
        ["Pack voltage", `${num(latest?.battery_voltage, 1)} V`],
        ["Reported charge", `${num(latest?.battery_soc, 0)}%`],
        [
          batteryConnection.inferred ? "Estimated power" : "Power",
          batteryConnection.value,
        ],
        ["15-minute average", `${num(mean, 2)} V`],
      ],
      note: `Charge estimate uses the 15-minute average voltage.${batteryConnection.inferred ? " Power is estimated from energy balance. Conversion losses are not included." : ""}`,
    },
    solar: {
      subtitle:
        latest?.pv_power == null
          ? "Awaiting data"
          : f.solarKw > 0.005
            ? "Generating"
            : "No production",
      value: powerLabel(
        latest?.pv_power == null ? null : latest.pv_power / 1000,
      ),
      unitLabel: "Solar power now",
      rows: [
        ["To home", powerLabel(latest?.pv_to_load_kw)],
        ["To battery", powerLabel(latest?.pv_to_battery_kw)],
        ["Connection", "DC to inverter"],
        ["MPPT voltage", `${num(latest?.mppt_battery_voltage, 1)} V`],
      ],
    },
    inverter: {
      subtitle: latest?.working_state ?? "Awaiting data",
      value: powerLabel(latest?.load_power),
      unitLabel: "Output to home",
      rows: [
        ["Rated output", powerLabel(loadMaxKw)],
        ["Battery voltage", `${num(latest?.battery_voltage, 1)} V`],
        ["Grid voltage", `${num(gridVoltage, 0)} V`],
      ],
    },
    home: {
      subtitle:
        latest?.load_power == null
          ? "Awaiting data"
          : f.loadKw > 0.01
            ? "Consuming"
            : "Idle",
      value: powerLabel(latest?.load_power),
      unitLabel: "Household consumption",
      rows: [
        ["From solar", powerLabel(latest?.pv_to_load_kw)],
        ["From battery", powerLabel(latest?.battery_to_load_kw)],
        ["From grid", powerLabel(latest?.grid_to_load_kw)],
        ["Load current", `${num(latest?.load_current, 1)} A`],
      ],
    },
    grid: {
      subtitle: gridStatus,
      value: `${num(gridVoltage, 0)} V`,
      unitLabel: "PLN input voltage",
      rows: [
        ["Power", gridConnection.value],
        ["To home", powerLabel(latest?.grid_to_load_kw)],
        [
          "To battery",
          f.gridToBatteryUnmetered
            ? "Unmetered"
            : powerLabel(latest?.grid_to_battery_kw),
        ],
        [
          "Source",
          gridConnection.minimum
            ? "Known minimum"
            : gridConnection.inferred
              ? "Inferred from balance"
              : latest
                ? "Device telemetry"
                : "Awaiting data",
        ],
      ],
      note: gridConnection.minimum
        ? "At least this much power supplies the home. Additional grid charging is unmetered."
        : gridConnection.inferred
          ? "Grid power is estimated from energy balance."
          : undefined,
    },
  };
  const detail = details[selected];
  return (
    <section className="energy-overview" aria-label="System overview">
      <div className="metric-strip">
        {metrics.map((m) => (
          <button
            key={m.id}
            className="metric-item"
            onClick={() => setSelected(m.id)}
            aria-pressed={selected === m.id}
          >
            <span className="metric-label">
              <m.icon size={15} style={{ color: m.color }} />
              {m.label}
              <ChevronRight size={13} className="metric-chevron" />
            </span>
            <div className="metric-main">
              <strong>{m.value}</strong>
              <Sparkline values={m.values} color={m.color} />
            </div>
            {m.caption && <span className="metric-caption">{m.caption}</span>}
          </button>
        ))}
      </div>
      <div className="system-panel">
        <div className="system-panel-header">
          <h2>Energy flow</h2>
          <div className="scene-toolbar">
            <span className={`live-badge ${fresh ? "is-live" : ""}`}>
              <span className="status-dot" />
              {fresh ? "Live" : latest ? "Last reading" : "No data"}
            </span>
            <IconButton
              label={paused ? "Resume flow animation" : "Pause flow animation"}
              onClick={() => setPaused(!paused)}
              aria-pressed={paused}
              disabled={reduced}
              title={
                reduced
                  ? "Animation follows your reduced motion preference"
                  : undefined
              }
            >
              {paused || reduced ? <Play size={14} /> : <Pause size={14} />}
            </IconButton>
          </div>
        </div>
        <div className="system-content">
          <Suspense
            fallback={
              <div className="scene-placeholder" role="status">
                <Box size={28} />
                <span>Loading…</span>
              </div>
            }
          >
            <EnergyScene
              connections={connections}
              selected={selected}
              onSelect={setSelected}
              soc={practical.practicalSocPct}
              motion={!paused && !reduced}
            />
          </Suspense>
          <aside
            id="device-inspector"
            className="device-inspector"
            aria-label={`${DEVICE_NAMES[selected]} details`}
          >
            <div className="inspector-heading">
              <span className="inspector-icon">
                <Icon size={21} strokeWidth={1.5} />
              </span>
              <div>
                <h3>{DEVICE_NAMES[selected]}</h3>
                <span>{detail.subtitle}</span>
              </div>
            </div>
            <div className="inspector-value">
              <strong>{detail.value}</strong>
              <span>{detail.unitLabel}</span>
            </div>
            {selected === "battery" && (
              <div
                className="battery-meter"
                aria-label={`Practical battery charge ${practical.practicalSocPct == null ? "unknown" : Math.round(practical.practicalSocPct) + " percent"}`}
              >
                {Array.from({ length: 25 }, (_, i) => (
                  <i
                    key={i}
                    className={
                      practical.practicalSocPct != null &&
                      practical.practicalSocPct > i * 4
                        ? "is-filled"
                        : ""
                    }
                  />
                ))}
              </div>
            )}
            <dl className="device-facts">
              {detail.rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {selected === "battery" && (
              <div className="threshold-summary">
                <span>
                  <ArrowDownLeft size={14} />
                  Switch to PLN <strong>{num(thresholds.a7, 1)} V</strong>
                </span>
                <span>
                  <ArrowUpRight size={14} />
                  Return to battery <strong>{num(thresholds.a6, 1)} V</strong>
                </span>
              </div>
            )}
            {detail.note && <p className="inspector-note">{detail.note}</p>}
            {selected === "battery" && eta && (
              <p className="eta-note">
                Estimated {eta.label.replace(/^~/, "")}.
              </p>
            )}
            {selected === "inverter" && (
              <a href="#controls" className="button button-secondary">
                Go to controls
                <ArrowRight size={14} />
              </a>
            )}
          </aside>
        </div>
        <div className="connection-footer">
          <div className="flow-legend">
            <span>
              <i style={{ background: C.solar }} />
              Solar
            </span>
            <span>
              <i style={{ background: C.charge }} />
              Charge
            </span>
            <span>
              <i style={{ background: C.discharge }} />
              Discharge
            </span>
            <span>
              <i style={{ background: C.grid }} />
              Grid
            </span>
            <span>
              <i style={{ background: C.load }} />
              Home
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => setShowConnections(!showConnections)}
            aria-expanded={showConnections}
            aria-controls="connection-details"
          >
            <Cable size={14} />
            Connections
            <ChevronRight
              size={14}
              style={{
                transform: showConnections ? "rotate(90deg)" : undefined,
              }}
            />
          </button>
        </div>
        {showConnections && (
          <div id="connection-details" className="connection-details">
            {connections.map((c) => (
              <div
                key={c.id}
                style={{ "--flow-color": c.color } as CSSProperties}
              >
                <span className="connection-type">{c.label}</span>
                <span>
                  {DEVICE_NAMES[c.from]}
                  <ArrowRight size={13} />
                  {DEVICE_NAMES[c.to]}
                </span>
                <strong>{c.value}</strong>
                <small>
                  {!latest
                    ? "No reading"
                    : !fresh
                      ? "Last reading"
                      : c.minimum
                        ? "Estimated minimum"
                        : c.unmetered
                          ? "Reported path"
                          : c.inferred
                            ? "Estimated"
                            : c.active
                              ? "Active"
                              : "Idle"}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
