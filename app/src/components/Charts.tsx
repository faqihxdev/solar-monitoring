import { memo, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryResponse, VoltageResponse, ThresholdEntry, Reading } from "../api";
import { practicalSocPct, voltageForPracticalSoc } from "../batteryModel";
import { C, FONT } from "../theme";
import { clockTime, fullTime, num } from "../format";

interface Props {
  hours: number;
  setHours: (h: number) => void;
  history: HistoryResponse | undefined;
  voltage: VoltageResponse | undefined;
  voltageThresholds: ThresholdEntry[];
  latest: Reading | null;
}

const RANGES = [
  { h: 6, label: "6H" },
  { h: 24, label: "24H" },
  { h: 168, label: "7D" },
];

const AXIS = {
  fill: C.textFaint,
  fontSize: 10,
  fontFamily: FONT.mono,
};

const CHART_SYNC_ID = "solar-charts-time-sync";

const SOC_Y_DOMAIN: [number, number] = [0, 100];

const THRESH_SHORT: Record<string, string> = {
  soc_to_mains: "SOC GRID",
  soc_resume_inverter: "SOC INV",
  a7_switch_pln: "A7 GRID",
  a6_return_pln: "A6 INV",
  a5_low_recovery: "A5 REC",
  a4_low_protection: "A4 CUT",
};

function limitLabel(text: string, color: string) {
  return (props: { viewBox?: { x: number; y: number; width: number; height: number } }) => {
    const vb = props.viewBox;
    if (!vb) return <g />;
    const w = text.length * 4.6;
    const x = vb.x + 2;
    const y = vb.y - 5;
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={10}
          rx={2}
          fill="#0a0c0d"
        />
        <text
          x={x + w / 2}
          y={y + 7}
          textAnchor="middle"
          fontFamily={FONT.mono}
          fontSize={7}
          fill={color}
        >
          {text}
        </text>
      </g>
    );
  };
}

interface Row {
  t: number;
  soc: number | null;
  pv: number | null;
  load: number | null;
  loadW: number;
  gridV: number | null;
  pvToLoad: number;
  batteryToLoad: number;
  gridToLoad: number;
  pvToLoadW: number;
  pvToChargeW: number;
  battToLoadW: number;
  gridToLoadW: number;
  v?: number | null;
  practicalSoc?: number | null;
  curveGuideV?: number | null;
}

interface VoltPoint {
  t: number;
  v: number | null;
}

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  digits,
  prefix,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: number;
  unit: string;
  digits: number;
  prefix?: boolean;
}) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-card border border-line-hi bg-bg px-3 py-2 font-mono text-xs shadow-xl shadow-black/40">
      <div className="mb-1.5 text-xs text-faint">{label ? fullTime(label) : ""}</div>
      {payload.map((p) => (
        <div className="flex items-center justify-between gap-4 leading-relaxed" key={p.name}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span>
            {p.value == null ? "—" : num(p.value, digits)}
            {prefix ? "" : ` ${unit}`}
          </span>
        </div>
      ))}
    </div>
  );
}

interface MetricChartBodyProps {
  data: Row[];
  dataKey: keyof Row;
  color: string;
  unit: string;
  digits: number;
  domain: [number, number];
  yDomain?: [number | ((v: number) => number), number | ((v: number) => number)];
  thresholds?: ThresholdEntry[];
  danger?: { from: number; to: number };
  wide?: boolean;
}

const MetricChartBody = memo(function MetricChartBody({
  data,
  dataKey,
  color,
  unit,
  digits,
  domain,
  yDomain,
  thresholds,
  danger,
  wide,
}: MetricChartBodyProps) {
  return (
    <ResponsiveContainer width="100%" height={wide ? 200 : 196}>
      <AreaChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        syncId={CHART_SYNC_ID}
      >
        <CartesianGrid stroke={C.line} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          tickFormatter={(v) => clockTime(v)}
          tick={AXIS}
          stroke={C.line}
          minTickGap={48}
        />
        <YAxis
          tick={AXIS}
          stroke={C.line}
          width={34}
          domain={yDomain ?? ["auto", "auto"]}
          allowDataOverflow={Boolean(yDomain)}
          tickFormatter={(v) => num(v, digits === 0 ? 0 : digits > 1 ? 1 : digits)}
        />
        {danger && (
          <ReferenceArea
            y1={danger.from}
            y2={danger.to}
            fill={C.bad}
            fillOpacity={0.07}
            stroke="none"
          />
        )}
        {thresholds?.map((t) => {
          const short = THRESH_SHORT[t.id] ?? "";
          const isVoltage = unit === "V";
          const primaryVal = isVoltage ? `${num(t.value, 1)}V` : `${Math.round(t.value)}%`;
          const singleVal =
            isVoltage && t.scale > 1 ? `${num(t.value / t.scale, 1)}V` : null;
          const labelText = short ? `${short} ${primaryVal}` : primaryVal;
          return (
            <ReferenceLine
              key={t.id}
              y={t.value}
              stroke={t.color}
              strokeOpacity={0.55}
              label={limitLabel(singleVal ? `${labelText} (${singleVal})` : labelText, t.color)}
            />
          );
        })}
        <Tooltip
          content={<ChartTooltip unit={unit} digits={digits} />}
          isAnimationActive={false}
          cursor={{ stroke: C.lineHi, strokeWidth: 1, strokeDasharray: "4 4" }}
        />
        <Area
          type="stepAfter"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.6}
          fill={color}
          fillOpacity={0.1}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

const SocChartBody = memo(function SocChartBody({
  data,
  domain,
  danger,
}: {
  data: Row[];
  domain: [number, number];
  danger?: { from: number; to: number };
}) {
  return (
    <ResponsiveContainer width="100%" height={196}>
      <AreaChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        syncId={CHART_SYNC_ID}
      >
        <CartesianGrid stroke={C.line} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          tickFormatter={(v) => clockTime(v)}
          tick={AXIS}
          stroke={C.line}
          minTickGap={48}
        />
        <YAxis
          tick={AXIS}
          stroke={C.line}
          width={34}
          domain={SOC_Y_DOMAIN}
          allowDataOverflow
          tickFormatter={(v) => num(v, 0)}
        />
        {danger && (
          <ReferenceArea
            y1={danger.from}
            y2={danger.to}
            fill={C.bad}
            fillOpacity={0.07}
            stroke="none"
          />
        )}
        <Tooltip
          content={<ChartTooltip unit="%" digits={0} />}
          isAnimationActive={false}
          cursor={{ stroke: C.lineHi, strokeWidth: 1, strokeDasharray: "4 4" }}
        />
        <Area
          type="stepAfter"
          dataKey="practicalSoc"
          name="Practical SOC"
          stroke={C.battery}
          strokeWidth={1.8}
          fill={C.battery}
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          type="stepAfter"
          dataKey="soc"
          name="Reported SOC"
          stroke={C.textDim}
          strokeOpacity={0.6}
          strokeWidth={1.3}
          fill={C.textDim}
          fillOpacity={0}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

function CombinedSocChart({
  data,
  currentPractical,
  currentReported,
  domain,
}: {
  data: Row[];
  currentPractical: string;
  currentReported: string;
  domain: [number, number];
}) {
  return (
    <div className="rounded-card border border-line bg-panel px-2.5 pb-2 pt-2.5 sm:px-3 sm:pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">Battery SOC</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.battery }}>{currentPractical} <small>%</small></span>
          <span className="text-sm text-faint">/</span>
          <span style={{ color: C.textFaint }}>{currentReported} <small>%</small></span>
        </span>
      </div>
      <SocChartBody data={data} domain={domain} danger={{ from: 0, to: 10 }} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">practical curve vs reported estimate</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.battery }} /> Practical
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.textFaint }} /> Reported
          </span>
        </div>
      </div>
    </div>
  );
}

const SOLAR_LOAD_ORDER = ["Solar", "Grid", "Load", "Discharge", "Charge"] as const;

function SolarLoadTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const byName = Object.fromEntries(payload.map((p) => [p.name, p]));
  const sorted = SOLAR_LOAD_ORDER.map((n) => byName[n]).filter(Boolean);
  return (
    <div className="rounded-card border border-line-hi bg-bg px-3 py-2 font-mono text-xs shadow-xl shadow-black/40">
      <div className="mb-1.5 text-xs text-faint">{label ? fullTime(label) : ""}</div>
      {sorted.map((p) => (
        <div className="flex items-center justify-between gap-4 leading-relaxed" key={p.name}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span>{num(p.value, 0)} W</span>
        </div>
      ))}
    </div>
  );
}

function PackVoltageTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const voltage = payload.find((p) => p.name === "Pack voltage");
  const practical = payload.find((p) => p.name === "Fixed SOC guide");
  return (
    <div className="rounded-card border border-line-hi bg-bg px-3 py-2 font-mono text-xs shadow-xl shadow-black/40">
      <div className="mb-1.5 text-xs text-faint">{label ? fullTime(label) : ""}</div>
      {voltage && (
        <div className="flex items-center justify-between gap-4 leading-relaxed">
          <span style={{ color: voltage.color }}>{voltage.name}</span>
          <span>{num(voltage.value, 1)} V</span>
        </div>
      )}
      {practical && (
        <div className="flex items-center justify-between gap-4 leading-relaxed">
          <span style={{ color: practical.color }}>{practical.name}</span>
          <span>{num(practical.value, 1)} V</span>
        </div>
      )}
    </div>
  );
}

const PackVoltageChartBody = memo(function PackVoltageChartBody({
  data,
  domain,
  yDomain,
  thresholds,
}: {
  data: Row[];
  domain: [number, number];
  yDomain?: [number | ((v: number) => number), number | ((v: number) => number)];
  thresholds?: ThresholdEntry[];
}) {
  return (
    <ResponsiveContainer width="100%" height={196}>
      <AreaChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        syncId={CHART_SYNC_ID}
      >
        <CartesianGrid stroke={C.line} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          tickFormatter={(v) => clockTime(v)}
          tick={AXIS}
          stroke={C.line}
          minTickGap={48}
        />
        <YAxis
          yAxisId="v"
          tick={AXIS}
          stroke={C.line}
          width={34}
          domain={yDomain ?? ["auto", "auto"]}
          allowDataOverflow={Boolean(yDomain)}
          tickFormatter={(v) => num(v, 1)}
        />
        <Area
          yAxisId="v"
          type="monotone"
          dataKey="curveGuideV"
          name="Fixed SOC guide"
          stroke={C.textDim}
          strokeOpacity={0.6}
          strokeWidth={1.3}
          fill={C.textDim}
          fillOpacity={0}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        {thresholds?.map((t) => {
          const short = THRESH_SHORT[t.id] ?? "";
          const primaryVal = `${num(t.value, 1)}V`;
          const singleVal = t.scale > 1 ? `${num(t.value / t.scale, 1)}V` : null;
          const labelText = short ? `${short} ${primaryVal}` : primaryVal;
          return (
            <ReferenceLine
              key={t.id}
              yAxisId="v"
              y={t.value}
              stroke={t.color}
              strokeOpacity={0.55}
              label={limitLabel(singleVal ? `${labelText} (${singleVal})` : labelText, t.color)}
            />
          );
        })}
        <Tooltip
          content={<PackVoltageTooltip />}
          isAnimationActive={false}
          cursor={{ stroke: C.lineHi, strokeWidth: 1, strokeDasharray: "4 4" }}
        />
        <Area
          yAxisId="v"
          type="stepAfter"
          dataKey="v"
          name="Pack voltage"
          stroke={C.battery}
          strokeWidth={1.6}
          fill={C.battery}
          fillOpacity={0.08}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

function PackVoltageChart({
  data,
  currentVoltage,
  currentPractical,
  domain,
  yDomain,
  thresholds,
}: {
  data: Row[];
  currentVoltage: string;
  currentPractical: string;
  domain: [number, number];
  yDomain?: [number | ((v: number) => number), number | ((v: number) => number)];
  thresholds?: ThresholdEntry[];
}) {
  return (
    <div className="rounded-card border border-line bg-panel px-2.5 pb-2 pt-2.5 sm:px-3 sm:pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">Pack Voltage</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.battery }}>{currentVoltage} <small>V</small></span>
          <span className="text-sm text-faint">/</span>
          <span style={{ color: C.textFaint }}>{currentPractical} <small>%</small></span>
        </span>
      </div>
      <PackVoltageChartBody
        data={data}
        domain={domain}
        yDomain={yDomain}
        thresholds={thresholds}
      />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">line axis with fixed practical V-% guide</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.battery }} /> Voltage
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.textDim }} /> Fixed SOC guide
          </span>
        </div>
      </div>
    </div>
  );
}

const SolarLoadChartBody = memo(function SolarLoadChartBody({
  data,
  domain,
}: {
  data: Row[];
  domain: [number, number];
}) {
  return (
    <ResponsiveContainer width="100%" height={196}>
      <AreaChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        syncId={CHART_SYNC_ID}
      >
        <CartesianGrid stroke={C.line} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          tickFormatter={(v) => clockTime(v)}
          tick={AXIS}
          stroke={C.line}
          minTickGap={48}
        />
        <YAxis
          tick={AXIS}
          stroke={C.line}
          width={34}
          tickFormatter={(v) => num(v, 0)}
        />
        <Tooltip
          content={<SolarLoadTooltip />}
          isAnimationActive={false}
          cursor={{ stroke: C.lineHi, strokeWidth: 1, strokeDasharray: "4 4" }}
        />
        {/* Stacked power flow: bottom→top = pvToLoad, battToLoad, gridToLoad, pvToCharge */}
        {/* Together they sum to total solar (pv). Load line sits at the charge boundary. */}
        <Area
          type="stepAfter"
          dataKey="pvToLoadW"
          name="Solar"
          stackId="flow"
          stroke={C.solar}
          strokeWidth={0}
          fill={C.solar}
          fillOpacity={0.45}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="battToLoadW"
          name="Discharge"
          stackId="flow"
          stroke={C.discharge}
          strokeWidth={0}
          fill={C.discharge}
          fillOpacity={0.5}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="gridToLoadW"
          name="Grid"
          stackId="flow"
          stroke={C.grid}
          strokeWidth={0}
          fill={C.grid}
          fillOpacity={0.5}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="pvToChargeW"
          name="Charge"
          stackId="flow"
          stroke={C.charge}
          strokeWidth={0}
          fill={C.charge}
          fillOpacity={0.5}
          dot={false}
          isAnimationActive={false}
        />
        {/* Load line — sits at the boundary between load and charging */}
        <Area
          type="stepAfter"
          dataKey="loadW"
          name="Load"
          stroke={C.load}
          strokeWidth={1.5}
          fill="none"
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

function SolarLoadChart({
  data,
  currentSolar,
  currentLoad,
  domain,
}: {
  data: Row[];
  currentSolar: string;
  currentLoad: string;
  domain: [number, number];
}) {
  return (
    <div className="rounded-card border border-line bg-panel px-2.5 pb-2 pt-2.5 sm:px-3 sm:pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">Solar / Load</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.solar }}>{currentSolar} <small>W</small></span>
          <span className="text-sm text-faint">/</span>
          <span style={{ color: C.load }}>{currentLoad} <small>kW</small></span>
        </span>
      </div>
      <SolarLoadChartBody data={data} domain={domain} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">solar production vs load demand</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.solar }} /> Solar</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.grid }} /> Grid</span>
          <span className="inline-flex items-center gap-1.5 text-faint"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.load }} /> Load</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.discharge }} /> Discharge</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.charge }} /> Charge</span>
        </div>
      </div>
    </div>
  );
}

function MetricChart({
  title,
  data,
  dataKey,
  color,
  unit,
  digits,
  current,
  domain,
  yDomain,
  thresholds,
  danger,
  wide,
  headerNote,
}: {
  title: string;
  data: Row[];
  dataKey: keyof Row;
  color: string;
  unit: string;
  digits: number;
  current: string;
  domain: [number, number];
  yDomain?: [number | ((v: number) => number), number | ((v: number) => number)];
  thresholds?: ThresholdEntry[];
  danger?: { from: number; to: number };
  wide?: boolean;
  headerNote?: string;
}) {
  return (
    <div className={`${wide ? "lg:col-span-full" : ""} rounded-card border border-line bg-panel px-2.5 pb-2 pt-2.5 sm:px-3 sm:pt-3`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">{title}</span>
        <span className="font-mono text-sm tabular-nums sm:text-base" style={{ color }}>
          {current} <small>{unit}</small>
        </span>
      </div>
      <MetricChartBody
        data={data}
        dataKey={dataKey}
        color={color}
        unit={unit}
        digits={digits}
        domain={domain}
        yDomain={yDomain}
        thresholds={thresholds}
        danger={danger}
        wide={wide}
      />
      {headerNote && (
        <div className="flex min-h-5 items-center justify-between pt-1.5">
          <span className="font-mono text-xs tracking-wide text-faint">{headerNote}</span>
        </div>
      )}
    </div>
  );
}


export default function Charts({
  hours,
  setHours,
  history,
  voltage,
  voltageThresholds,
  latest,
}: Props) {
  const rows: Row[] = useMemo(
    () =>
      (history?.points ?? []).map((p) => ({
        t: p.polled_at * 1000,
        soc: p.battery_soc,
        pv: p.pv_power,
        load: p.load_power,
        gridV: p.grid_voltage,
        pvToLoad: p.pv_to_load_kw ?? 0,
        batteryToLoad: p.battery_to_load_kw ?? 0,
        gridToLoad: p.grid_to_load_kw ?? 0,
        loadW: (p.load_power ?? 0) * 1000,
        pvToLoadW: (p.pv_to_load_kw ?? 0) * 1000,
        pvToChargeW: (p.pv_to_battery_kw ?? 0) * 1000,
        battToLoadW: (p.battery_to_load_kw ?? 0) * 1000,
        gridToLoadW: (p.grid_to_load_kw ?? 0) * 1000,
        v: p.battery_voltage,
        practicalSoc: null,
        curveGuideV: null,
      })),
    [history]
  );

  const serverNow = (history?.server_now ?? Date.now() / 1000) * 1000;
  const windowMs = hours * 3600 * 1000;

  const voltageSeries = useMemo<VoltPoint[]>(
    () =>
      (voltage?.points ?? []).map((p) => ({
        t: p.sampled_at * 1000,
        v: p.battery_voltage,
      })),
    [voltage]
  );

  const voltRows = useMemo(
    () => {
      if (rows.length) {
        if (!voltageSeries.length) {
          return rows.map((r) => ({
            ...r,
            v: r.v ?? latest?.battery_voltage ?? null,
          }));
        }
        let idx = 0;
        return rows.map((r) => {
          while (idx + 1 < voltageSeries.length && voltageSeries[idx + 1].t <= r.t) {
            idx += 1;
          }
          let best = voltageSeries[idx];
          if (idx + 1 < voltageSeries.length) {
            const next = voltageSeries[idx + 1];
            if (Math.abs(next.t - r.t) < Math.abs(best.t - r.t)) {
              best = next;
            }
          }
          return {
            ...r,
            v: best.v ?? r.v ?? latest?.battery_voltage ?? null,
          };
        });
      }

      const points: Row[] = voltageSeries.map((p) => ({
        t: p.t,
        soc: null,
        pv: null,
        load: null,
        loadW: 0,
        gridV: null,
        pvToLoad: 0,
        batteryToLoad: 0,
        gridToLoad: 0,
        pvToLoadW: 0,
        pvToChargeW: 0,
        battToLoadW: 0,
        gridToLoadW: 0,
        v: p.v,
        practicalSoc: null,
        curveGuideV: null,
      }));

      const lastPoint = points[points.length - 1];
      const latestV = latest?.battery_voltage ?? lastPoint?.v ?? null;
      if (latestV != null && points.length) {
        const lastT = lastPoint?.t ?? 0;
        if (serverNow > lastT) {
          points.push({
            t: serverNow,
            soc: null,
            pv: null,
            load: null,
            loadW: 0,
            gridV: null,
            pvToLoad: 0,
            batteryToLoad: 0,
            gridToLoad: 0,
            pvToLoadW: 0,
            pvToChargeW: 0,
            battToLoadW: 0,
            gridToLoadW: 0,
            v: latestV,
            practicalSoc: null,
            curveGuideV: null,
          });
        }
      }
      return points;
    },
    [latest?.battery_voltage, rows, serverNow, voltageSeries]
  );

  const batteryRows = useMemo(
    () => {
      if (!voltRows.length) return [];
      const minT = voltRows[0].t;
      const maxT = voltRows[voltRows.length - 1].t;
      const span = Math.max(1, maxT - minT);
      return voltRows.map((r) => {
        // "Pretend" hidden SOC axis: peg 0% -> 100% linearly across the visible time window.
        const windowSoc = ((r.t - minT) / span) * 100;
        return {
          ...r,
          practicalSoc: practicalSocPct(r.v),
          curveGuideV: voltageForPracticalSoc(windowSoc),
        };
      });
    },
    [voltRows]
  );

  const domain = useMemo<[number, number]>(() => {
    const domainStart = rows.length
      ? Math.min(rows[0].t, serverNow - windowMs)
      : serverNow - windowMs;
    return [domainStart, serverNow];
  }, [rows, serverNow, windowMs]);

  const voltDomain = useMemo<
    [number | ((v: number) => number), number | ((v: number) => number)] | undefined
  >(() => {
    const vThVals = voltageThresholds.map((t) => t.value);
    const vMin = vThVals.length ? Math.min(...vThVals) : null;
    const vMax = vThVals.length ? Math.max(...vThVals) : null;
    return vMin != null && vMax != null
      ? [(min: number) => Math.min(min, vMin) - 0.3, (max: number) => Math.max(max, vMax) + 0.3]
      : undefined;
  }, [voltageThresholds]);

  const cur = (v: number | null | undefined, d: number) =>
    v == null ? "—" : num(v, d);
  const latestPracticalSoc = practicalSocPct(latest?.battery_voltage);

  return (
    <section className="mt-6 animate-[fadein_0.5s_ease_both]">
      <div className="mb-2.5 flex items-baseline justify-between gap-3 border-b border-line pb-2 sm:mb-3 sm:gap-4">
        <h2 className="m-0 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-dim">Trends</h2>
        <div className="inline-flex overflow-hidden rounded-card border border-line">
          {RANGES.map((r) => (
            <button
              key={r.h}
              className={`border-r border-line px-2.5 py-1.5 font-mono text-xs transition-colors last:border-r-0 sm:px-3.5 ${
                hours === r.h
                  ? "bg-panel-hi text-solar"
                  : "bg-panel text-dim hover:border-line-hi hover:text-text"
              }`}
              onClick={() => setHours(r.h)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 lg:gap-3.5">
        <CombinedSocChart
          data={batteryRows}
          currentPractical={cur(latestPracticalSoc, 0)}
          currentReported={cur(latest?.battery_soc, 0)}
          domain={domain}
        />
        <PackVoltageChart
          data={batteryRows}
          currentVoltage={cur(latest?.battery_voltage, 1)}
          currentPractical={cur(latestPracticalSoc, 0)}
          domain={domain}
          yDomain={voltDomain}
          thresholds={voltageThresholds}
        />
        <SolarLoadChart
          data={rows}
          currentSolar={cur(latest?.pv_power, 0)}
          currentLoad={cur(latest?.load_power, 2)}
          domain={domain}
        />
        <MetricChart
          title="Grid voltage"
          data={rows}
          dataKey="gridV"
          color={C.grid}
          unit="V"
          digits={0}
          current={cur(latest?.grid_voltage, 0)}
          domain={domain}
        />
      </div>
    </section>
  );
}
