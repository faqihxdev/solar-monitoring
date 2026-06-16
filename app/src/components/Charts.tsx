import { memo, useMemo, Fragment } from "react";
import { LineChart } from "lucide-react";
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
import {
  meanVoltage,
  practicalSocPct,
  voltageForPracticalSoc,
  PRACTICAL_SOC_SMOOTHING_MINUTES,
} from "../batteryModel";
import { C, FONT } from "../theme";
import {
  clockTime,
  fullTime,
  num,
  jakartaMidnightMs,
  jakartaMidnightMsForDate,
  hoursForRange,
  offsetDate,
  formatDayShort,
  todayJkt,
} from "../format";
import type { RangeKey } from "../format";

interface Props {
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  chartDate: string;
  setChartDate: (d: string) => void;
  history: HistoryResponse | undefined;
  voltage: VoltageResponse | undefined;
  voltageThresholds: ThresholdEntry[];
  latest: Reading | null;
}

const RANGES: { key: RangeKey; label: string; title?: string }[] = [
  { key: "6h", label: "6H" },
  { key: "12h", label: "12H" },
  { key: "1d", label: "1D" },
  { key: "3d", label: "3D" },
  { key: "1w", label: "1W" },
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
  a3_float_charge: "A3 FLT",
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
          type="monotone"
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
          stroke="rgba(200,204,210,0.2)"
          strokeWidth={1.2}
          fill="none"
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
          <span style={{ color: C.load, opacity: 0.5 }}>{currentReported} <small>%</small></span>
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
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.load, opacity: 0.5 }} /> Reported
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
          stroke="rgba(200,204,210,0.2)"
          strokeWidth={1.2}
          fill="none"
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
            <i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.load, opacity: 0.5 }} /> Fixed SOC guide
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
    <ResponsiveContainer width="100%" height={240}>
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
  currentPvToLoad,
  currentBattToLoad,
  currentGridToLoad,
  domain,
}: {
  data: Row[];
  currentPvToLoad: string;
  currentBattToLoad: string;
  currentGridToLoad: string;
  domain: [number, number];
}) {
  const sources = [
    { value: currentPvToLoad, color: C.solar },
    { value: currentBattToLoad, color: C.discharge },
    { value: currentGridToLoad, color: C.grid },
  ];
  const hasAny = sources.some((s) => s.value !== "—");
  return (
    <div className="rounded-card border border-line bg-panel px-2.5 pb-2 pt-2.5 sm:px-3 sm:pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">Load Sources</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          {!hasAny ? (
            <span className="text-faint">—</span>
          ) : (
            sources.map((s, i) => {
              const active = s.value !== "—" && s.value !== "0.0";
              return (
                <Fragment key={i}>
                  {i > 0 && <span className="text-xs text-faint">/</span>}
                  <span style={{ color: s.color }} className={active ? "" : "opacity-35"}>
                    {s.value} <small>kW</small>
                  </span>
                </Fragment>
              );
            })
          )}
        </span>
      </div>
      <SolarLoadChartBody data={data} domain={domain} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">load power sources</span>
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

function SolarGenTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const solar = payload.find((p) => p.name === "Solar");
  const load = payload.find((p) => p.name === "Load");
  return (
    <div className="rounded-card border border-line-hi bg-bg px-3 py-2 font-mono text-xs shadow-xl shadow-black/40">
      <div className="mb-1.5 text-xs text-faint">{label ? fullTime(label) : ""}</div>
      {solar && (
        <div className="flex items-center justify-between gap-4 leading-relaxed">
          <span style={{ color: solar.color }}>Solar</span>
          <span>{num(solar.value, 0)} W</span>
        </div>
      )}
      {load && (
        <div className="flex items-center justify-between gap-4 leading-relaxed">
          <span style={{ color: load.color }}>Load</span>
          <span>{num(load.value, 0)} W</span>
        </div>
      )}
    </div>
  );
}

const SolarGenerationChartBody = memo(function SolarGenerationChartBody({
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
          domain={[0, "auto"]}
          tickFormatter={(v) => num(v, 0)}
        />
        <Tooltip
          content={<SolarGenTooltip />}
          isAnimationActive={false}
          cursor={{ stroke: C.lineHi, strokeWidth: 1, strokeDasharray: "4 4" }}
        />
        <Area
          type="stepAfter"
          dataKey="pv"
          name="Solar"
          stroke={C.solar}
          strokeWidth={1.6}
          fill={C.solar}
          fillOpacity={0.15}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          type="stepAfter"
          dataKey="loadW"
          name="Load"
          stroke="rgba(200,204,210,0.2)"
          strokeWidth={1.2}
          fill="none"
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

function SolarGenerationChart({
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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim sm:text-xs sm:tracking-widest">Solar Generation</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.solar }}>{currentSolar} <small>W</small></span>
          <span className="text-xs text-faint">/</span>
          <span className="text-faint">{currentLoad} <small>W</small></span>
        </span>
      </div>
      <SolarGenerationChartBody data={data} domain={domain} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">total pv output</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-xs" style={{ background: C.solar }} /> Solar</span>
          <span className="inline-flex items-center gap-1.5 text-faint"><i className="inline-block h-0.5 w-2.5" style={{ background: C.load, opacity: 0.5 }} /> Load</span>
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
  range,
  setRange,
  chartDate,
  setChartDate,
  history,
  voltage,
  voltageThresholds,
  latest,
}: Props) {
  const today = todayJkt();
  const isChartToday = chartDate === today;
  const canGoNext = !isChartToday;

  // All points returned by the API (may span more hours than the visible window for
  // historical dates, since we over-fetch to ensure coverage).
  const rawRows: Row[] = useMemo(
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

  // The end of the selected chart date (server-now for today, midnight of next day for past dates)
  const chartEndMs = isChartToday
    ? serverNow
    : jakartaMidnightMsForDate(offsetDate(chartDate, 1));

  // Window duration: for a past "today" range treat it as a full 24-hour day
  const rangeWindowMs = range === "today" && !isChartToday
    ? 24 * 3600_000
    : hoursForRange(range) * 3600_000;

  // Visible time domain — computed before filtering so rawRows[0].t can inform the live left edge.
  const domain = useMemo<[number, number]>(() => {
    let domainStart: number;
    if (range === "today") {
      domainStart = isChartToday ? jakartaMidnightMs() : jakartaMidnightMsForDate(chartDate);
    } else {
      const naturalStart = chartEndMs - rangeWindowMs;
      domainStart = isChartToday && rawRows.length
        ? Math.min(rawRows[0].t, naturalStart)
        : naturalStart;
    }
    return [domainStart, chartEndMs];
  }, [range, rawRows, chartDate, chartEndMs, rangeWindowMs, isChartToday]);

  // Rows clipped to the visible window so Recharts never renders out-of-domain data.
  const rows = useMemo(
    () => rawRows.filter((r) => r.t >= domain[0] && r.t <= domain[1]),
    [rawRows, domain]
  );

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

      // Voltage-only fallback (no telemetry rows): clip voltage series to domain too.
      const points: Row[] = voltageSeries
        .filter((p) => p.t >= domain[0] && p.t <= domain[1])
        .map((p) => ({
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
    [latest?.battery_voltage, rows, serverNow, voltageSeries, domain]
  );

  const batteryRows = useMemo(
    () => {
      if (!voltRows.length) return [];
      const minT = voltRows[0].t;
      const maxT = voltRows[voltRows.length - 1].t;
      const span = Math.max(1, maxT - minT);
      const halfWindowMs = (PRACTICAL_SOC_SMOOTHING_MINUTES * 60 * 1000) / 2;
      return voltRows.map((r, i) => {
        // "Pretend" hidden SOC axis: peg 0% -> 100% linearly across the visible time window.
        const windowSoc = ((r.t - minT) / span) * 100;
        // Centered 15-min moving AVERAGE of voltage. A mean (not median) is used
        // here on purpose: voltage is quantized to 0.2V steps, so a median just
        // re-picks one of those discrete levels and the line stays stepped. The
        // mean produces in-between voltages (e.g. 25.5V) that map to a smooth %.
        const lo = r.t - halfWindowMs;
        const hi = r.t + halfWindowMs;
        let sum = 0;
        let count = 0;
        for (let j = i; j >= 0 && voltRows[j].t >= lo; j--) {
          const vj = voltRows[j].v;
          if (vj != null && Number.isFinite(vj)) {
            sum += vj;
            count += 1;
          }
        }
        for (let j = i + 1; j < voltRows.length && voltRows[j].t <= hi; j++) {
          const vj = voltRows[j].v;
          if (vj != null && Number.isFinite(vj)) {
            sum += vj;
            count += 1;
          }
        }
        const smoothedV = count ? sum / count : r.v;
        return {
          ...r,
          practicalSoc: practicalSocPct(smoothedV),
          curveGuideV: voltageForPracticalSoc(windowSoc),
        };
      });
    },
    [voltRows]
  );

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
  // Displayed "current" practical SOC uses a trailing-mean voltage to match the
  // smoothed gauge and the (centered-mean) plotted trend line.
  const smoothedLatestVoltage = meanVoltage(
    [
      ...(voltage?.points ?? []).map((p) => ({ t: p.sampled_at, v: p.battery_voltage })),
      ...(latest ? [{ t: latest.polled_at, v: latest.battery_voltage }] : []),
    ],
    latest?.polled_at,
  );
  const latestPracticalSoc = practicalSocPct(
    smoothedLatestVoltage ?? latest?.battery_voltage,
  );

  return (
    <section className="mt-6 animate-[fadein_0.5s_ease_both]">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
        <h2 className="m-0 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-dim">
          <LineChart size={14} strokeWidth={1.8} /> Trends
        </h2>
        <div className="inline-flex items-center gap-2">
          {/* Range window buttons — only meaningful when viewing live (today) data.
              Clicking one resets the date back to today. */}
          <div className="inline-flex overflow-hidden rounded-card border border-line">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={`border-r border-line px-2 py-1.5 font-mono text-xs transition-colors last:border-r-0 sm:px-2.5 ${
                  isChartToday && range === r.key
                    ? "bg-panel-hi text-solar"
                    : "bg-panel text-dim hover:border-line-hi hover:text-text"
                }`}
                title={r.title}
                onClick={() => {
                  setRange(r.key);
                  setChartDate(today); // always jump back to live when a range is chosen
                }}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Separator */}
          <div className="h-5 w-px bg-line" />

          {/* Date navigator — arrows always clickable; date text fades when not driving the view. */}
          <div className="inline-flex items-center gap-1">
            <button
              className="grid h-6.5 w-6.5 cursor-pointer place-items-center rounded-card border border-line bg-panel p-0 text-base leading-none text-dim transition-colors hover:border-line-hi hover:text-text"
              onClick={() => {
                setChartDate(offsetDate(chartDate, -1));
                setRange("today"); // past-day view is always full-day
              }}
              title="Previous day"
            >
              ‹
            </button>
            <span
              className="inline-flex min-w-14 items-center justify-center font-mono text-xs tabular-nums transition-opacity"
              style={{ color: isChartToday ? C.charge : C.textDim, opacity: range !== "today" ? 0.45 : 1 }}
            >
              {formatDayShort(chartDate)}
            </span>
            <button
              className={`grid h-6.5 w-6.5 place-items-center rounded-card border bg-panel p-0 text-base leading-none transition-colors ${
                !canGoNext
                  ? "cursor-default border-line text-dim opacity-30"
                  : "cursor-pointer border-line text-dim hover:border-line-hi hover:text-text"
              }`}
              onClick={() => {
                if (!canGoNext) return;
                const next = offsetDate(chartDate, 1);
                setChartDate(next);
                if (next !== today) setRange("today"); // still a past day → full-day view
              }}
              title="Next day"
              disabled={!canGoNext}
            >
              ›
            </button>
          </div>
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
        <SolarGenerationChart
          data={rows}
          currentSolar={cur(latest?.pv_power, 0)}
          currentLoad={cur(latest?.load_power == null ? null : latest.load_power * 1000, 0)}
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
        <div className="lg:col-span-2">
          <SolarLoadChart
            data={rows}
            currentPvToLoad={cur(latest?.pv_to_load_kw, 1)}
            currentBattToLoad={cur(latest?.battery_to_load_kw, 1)}
            currentGridToLoad={cur(latest?.grid_to_load_kw, 1)}
            domain={domain}
          />
        </div>
      </div>
    </section>
  );
}
