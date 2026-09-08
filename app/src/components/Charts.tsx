import { memo, useMemo, Fragment } from "react";
import { DateNavigator, EmptyState, SectionHeading } from "./ui";
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
import type {
  HistoryResponse,
  VoltageResponse,
  ThresholdEntry,
  Reading,
} from "../api";
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
  loading: boolean;
}

const RANGES: { key: RangeKey; label: string; title?: string }[] = [
  { key: "6h", label: "6h" },
  { key: "12h", label: "12h" },
  { key: "1d", label: "1d" },
  { key: "3d", label: "3d" },
  { key: "1w", label: "1w" },
];

const AXIS = {
  fill: C.textFaint,
  fontSize: 11,
  fontFamily: FONT.display,
};

const CHART_SYNC_ID = "solar-charts-time-sync";

const SOC_Y_DOMAIN: [number, number] = [0, 100];
const GRID_LOW_VOLTAGE_V = 50;

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
  return (props: {
    viewBox?: { x: number; y: number; width: number; height: number };
  }) => {
    const vb = props.viewBox;
    if (!vb) return <g />;
    const w = text.length * 4.6;
    const x = vb.x + 2;
    const y = vb.y - 5;
    return (
      <g>
        <rect x={x} y={y} width={w} height={10} rx={2} fill={C.panel} />
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
      <div className="mb-1.5 text-xs text-faint">
        {label ? fullTime(label) : ""}
      </div>
      {payload.map((p) => (
        <div
          className="flex items-center justify-between gap-4 leading-relaxed"
          key={p.name}
        >
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
  yDomain?: [
    number | ((v: number) => number),
    number | ((v: number) => number),
  ];
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
          tickFormatter={(v) =>
            num(v, digits === 0 ? 0 : digits > 1 ? 1 : digits)
          }
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
          const primaryVal = isVoltage
            ? `${num(t.value, 1)}V`
            : `${Math.round(t.value)}%`;
          const singleVal =
            isVoltage && t.scale > 1 ? `${num(t.value / t.scale, 1)}V` : null;
          const labelText = short ? `${short} ${primaryVal}` : primaryVal;
          return (
            <ReferenceLine
              key={t.id}
              y={t.value}
              stroke={t.color}
              strokeOpacity={0.55}
              label={limitLabel(
                singleVal ? `${labelText} (${singleVal})` : labelText,
                t.color,
              )}
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
          strokeWidth={2}
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
          strokeWidth={2}
          fill={C.battery}
          fillOpacity={0.28}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          type="stepAfter"
          dataKey="soc"
          name="Reported SOC"
          stroke="rgba(200,200,200,0.55)"
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
    <div className="chart-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="chart-title">Battery state of charge</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.battery }}>
            {currentPractical} <small>%</small>
          </span>
          <span className="text-sm text-faint">/</span>
          <span style={{ color: C.load, opacity: 0.7 }}>
            {currentReported} <small>%</small>
          </span>
        </span>
      </div>
      <SocChartBody data={data} domain={domain} danger={{ from: 0, to: 10 }} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">
          Voltage-based estimate and device reading
        </span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.battery }}
            />{" "}
            Practical
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.load, opacity: 0.7 }}
            />{" "}
            Reported
          </span>
        </div>
      </div>
    </div>
  );
}

// White keeps the load boundary distinct over the stacked source colors.
const ENERGY_SOURCES_LOAD_COLOR = "#ffffff";
const SOLAR_LOAD_ORDER = [
  "Solar",
  "Grid",
  "Load",
  "Discharge",
  "Charge",
] as const;

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
      <div className="mb-1.5 text-xs text-faint">
        {label ? fullTime(label) : ""}
      </div>
      {sorted.map((p) => (
        <div
          className="flex items-center justify-between gap-4 leading-relaxed"
          key={p.name}
        >
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
      <div className="mb-1.5 text-xs text-faint">
        {label ? fullTime(label) : ""}
      </div>
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
  yDomain?: [
    number | ((v: number) => number),
    number | ((v: number) => number),
  ];
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
          stroke="rgba(200,200,200,0.55)"
          strokeWidth={1.2}
          fill="none"
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        {thresholds?.map((t) => {
          const short = THRESH_SHORT[t.id] ?? "";
          const primaryVal = `${num(t.value, 1)}V`;
          const singleVal =
            t.scale > 1 ? `${num(t.value / t.scale, 1)}V` : null;
          const labelText = short ? `${short} ${primaryVal}` : primaryVal;
          return (
            <ReferenceLine
              key={t.id}
              yAxisId="v"
              y={t.value}
              stroke={t.color}
              strokeOpacity={0.55}
              label={limitLabel(
                singleVal ? `${labelText} (${singleVal})` : labelText,
                t.color,
              )}
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
          strokeWidth={2}
          fill={C.battery}
          fillOpacity={0.24}
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
  yDomain?: [
    number | ((v: number) => number),
    number | ((v: number) => number),
  ];
  thresholds?: ThresholdEntry[];
}) {
  return (
    <div className="chart-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="chart-title">Battery voltage</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.battery }}>
            {currentVoltage} <small>V</small>
          </span>
          <span className="text-sm text-faint">/</span>
          <span style={{ color: C.textFaint }}>
            {currentPractical} <small>%</small>
          </span>
        </span>
      </div>
      <PackVoltageChartBody
        data={data}
        domain={domain}
        yDomain={yDomain}
        thresholds={thresholds}
      />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">
          Pack voltage and reference charge curve
        </span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.battery }}
            />{" "}
            Voltage
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.load, opacity: 0.7 }}
            />{" "}
            Fixed SOC guide
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
        {/* Sources supply load plus charging. The load line marks that boundary. */}
        <Area
          type="stepAfter"
          dataKey="pvToLoadW"
          name="Solar"
          stackId="flow"
          stroke={C.solar}
          strokeWidth={0.9}
          fill={C.solar}
          fillOpacity={0.66}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="battToLoadW"
          name="Discharge"
          stackId="flow"
          stroke={C.discharge}
          strokeWidth={0.9}
          fill={C.discharge}
          fillOpacity={0.66}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="gridToLoadW"
          name="Grid"
          stackId="flow"
          stroke={C.grid}
          strokeWidth={0.9}
          fill={C.grid}
          fillOpacity={0.66}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="stepAfter"
          dataKey="pvToChargeW"
          name="Charge"
          stackId="flow"
          stroke={C.charge}
          strokeWidth={0.9}
          fill={C.charge}
          fillOpacity={0.66}
          dot={false}
          isAnimationActive={false}
        />
        {/* Load line — sits at the boundary between load and charging */}
        <Area
          type="stepAfter"
          dataKey="loadW"
          name="Load"
          stroke={ENERGY_SOURCES_LOAD_COLOR}
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
    <div className="chart-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="chart-title">Energy sources</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          {!hasAny ? (
            <span className="text-faint">—</span>
          ) : (
            sources.map((s, i) => {
              const active = s.value !== "—" && s.value !== "0.0";
              return (
                <Fragment key={i}>
                  {i > 0 && <span className="text-xs text-faint">/</span>}
                  <span
                    style={{ color: s.color }}
                    className={active ? "" : "opacity-35"}
                  >
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
        <span className="font-mono text-xs tracking-wide text-faint">
          Power delivered by each source
        </span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.solar }}
            />{" "}
            Solar
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.grid }}
            />{" "}
            Grid
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: ENERGY_SOURCES_LOAD_COLOR }}
            />{" "}
            Load
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.discharge }}
            />{" "}
            Discharge
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.charge }}
            />{" "}
            Charge
          </span>
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
      <div className="mb-1.5 text-xs text-faint">
        {label ? fullTime(label) : ""}
      </div>
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
          strokeWidth={2}
          fill={C.solar}
          fillOpacity={0.32}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
        <Area
          type="stepAfter"
          dataKey="loadW"
          name="Load"
          stroke="rgba(200,200,200,0.55)"
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
    <div className="chart-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="chart-title">Solar generation</span>
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular-nums sm:text-base">
          <span style={{ color: C.solar }}>
            {currentSolar} <small>W</small>
          </span>
          <span className="text-xs text-faint">/</span>
          <span className="text-faint">
            {currentLoad} <small>W</small>
          </span>
        </span>
      </div>
      <SolarGenerationChartBody data={data} domain={domain} />
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5 pt-1.5">
        <span className="font-mono text-xs tracking-wide text-faint">
          Panel output and household demand
        </span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-xs"
              style={{ background: C.solar }}
            />{" "}
            Solar
          </span>
          <span className="inline-flex items-center gap-1.5 text-faint">
            <i
              className="inline-block h-0.5 w-2.5"
              style={{ background: C.load, opacity: 0.7 }}
            />{" "}
            Load
          </span>
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
  yDomain?: [
    number | ((v: number) => number),
    number | ((v: number) => number),
  ];
  thresholds?: ThresholdEntry[];
  danger?: { from: number; to: number };
  wide?: boolean;
  headerNote?: string;
}) {
  return (
    <div className={`${wide ? "lg:col-span-full" : ""} chart-panel`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="chart-title">{title}</span>
        <span
          className="font-mono text-sm tabular-nums sm:text-base"
          style={{ color }}
        >
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
          <span className="font-mono text-xs tracking-wide text-faint">
            {headerNote}
          </span>
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
  loading,
}: Props) {
  const today = todayJkt();
  const isChartToday = chartDate === today;

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
    [history],
  );

  const serverNow = (history?.server_now ?? Date.now() / 1000) * 1000;

  // The end of the selected chart date (server-now for today, midnight of next day for past dates)
  const chartEndMs = isChartToday
    ? serverNow
    : jakartaMidnightMsForDate(offsetDate(chartDate, 1));

  // Window duration: for a past "today" range treat it as a full 24-hour day
  const rangeWindowMs =
    range === "today" && !isChartToday
      ? 24 * 3600_000
      : hoursForRange(range) * 3600_000;

  // Visible time domain — computed before filtering so rawRows[0].t can inform the live left edge.
  const domain = useMemo<[number, number]>(() => {
    let domainStart: number;
    if (range === "today") {
      domainStart = isChartToday
        ? jakartaMidnightMs()
        : jakartaMidnightMsForDate(chartDate);
    } else {
      const naturalStart = chartEndMs - rangeWindowMs;
      domainStart =
        isChartToday && rawRows.length
          ? Math.min(rawRows[0].t, naturalStart)
          : naturalStart;
    }
    return [domainStart, chartEndMs];
  }, [range, rawRows, chartDate, chartEndMs, rangeWindowMs, isChartToday]);

  // Rows clipped to the visible window so Recharts never renders out-of-domain data.
  const rows = useMemo(
    () => rawRows.filter((r) => r.t >= domain[0] && r.t <= domain[1]),
    [rawRows, domain],
  );

  const voltageSeries = useMemo<VoltPoint[]>(
    () =>
      (voltage?.points ?? []).map((p) => ({
        t: p.sampled_at * 1000,
        v: p.battery_voltage,
      })),
    [voltage],
  );

  const voltRows = useMemo(() => {
    if (rows.length) {
      if (!voltageSeries.length) {
        return rows.map((r) => ({
          ...r,
          v: r.v ?? (isChartToday ? latest?.battery_voltage : null) ?? null,
        }));
      }
      let idx = 0;
      return rows.map((r) => {
        while (
          idx + 1 < voltageSeries.length &&
          voltageSeries[idx + 1].t <= r.t
        ) {
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
          v:
            best.v ??
            r.v ??
            (isChartToday ? latest?.battery_voltage : null) ??
            null,
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
    if (isChartToday && latestV != null && points.length) {
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
  }, [
    latest?.battery_voltage,
    rows,
    serverNow,
    voltageSeries,
    domain,
    isChartToday,
  ]);

  const batteryRows = useMemo(() => {
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
  }, [voltRows]);

  const voltDomain = useMemo<
    | [number | ((v: number) => number), number | ((v: number) => number)]
    | undefined
  >(() => {
    const vThVals = voltageThresholds.map((t) => t.value);
    const vMin = vThVals.length ? Math.min(...vThVals) : null;
    const vMax = vThVals.length ? Math.max(...vThVals) : null;
    return vMin != null && vMax != null
      ? [
          (min: number) => Math.min(min, vMin) - 0.3,
          (max: number) => Math.max(max, vMax) + 0.3,
        ]
      : undefined;
  }, [voltageThresholds]);

  const cur = (v: number | null | undefined, d: number) =>
    v == null ? "—" : num(v, d);
  // Displayed "current" practical SOC uses a trailing-mean voltage to match the
  // smoothed gauge and the (centered-mean) plotted trend line.
  const smoothedLatestVoltage = meanVoltage(
    [
      ...(voltage?.points ?? []).map((p) => ({
        t: p.sampled_at,
        v: p.battery_voltage,
      })),
      ...(latest ? [{ t: latest.polled_at, v: latest.battery_voltage }] : []),
    ],
    latest?.polled_at,
  );
  const latestPracticalSoc = practicalSocPct(
    smoothedLatestVoltage ?? latest?.battery_voltage,
  );
  const lastBatteryRow = batteryRows[batteryRows.length - 1];
  const displayedReading = isChartToday
    ? latest
    : (history?.points ?? [])
        .filter(
          (p) =>
            p.polled_at * 1000 >= domain[0] && p.polled_at * 1000 <= domain[1],
        )
        .slice(-1)[0];
  const displayedSoc = isChartToday
    ? latestPracticalSoc
    : lastBatteryRow?.practicalSoc;
  const displayedVoltage = isChartToday
    ? latest?.battery_voltage
    : lastBatteryRow?.v;
  const gridVoltage = displayedReading?.grid_voltage ?? null;
  const gridVoltageColor =
    gridVoltage != null && gridVoltage < GRID_LOW_VOLTAGE_V ? C.bad : C.grid;

  return (
    <section className="charts-section" aria-label="Energy trends">
      <SectionHeading
        title="Trends"
        description={isChartToday ? "GMT+7" : "Period-end values · GMT+7"}
      >
        <div className="range-controls">
          <div className="range-buttons" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                aria-pressed={isChartToday && range === r.key}
                onClick={() => {
                  setRange(r.key);
                  setChartDate(today);
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <DateNavigator
            date={chartDate}
            onChange={(date) => {
              setChartDate(date);
              setRange("today");
            }}
          />
        </div>
      </SectionHeading>
      {!history && !voltage && loading ? (
        <div className="page-loading" role="status">
          Loading historical readings…
        </div>
      ) : !rows.length && !batteryRows.length ? (
        <EmptyState
          title="No readings in this period"
          description="Choose another date or a longer time range."
        />
      ) : (
        <div className="chart-grid">
          <CombinedSocChart
            data={batteryRows}
            currentPractical={cur(displayedSoc, 0)}
            currentReported={cur(displayedReading?.battery_soc, 0)}
            domain={domain}
          />
          <PackVoltageChart
            data={batteryRows}
            currentVoltage={cur(displayedVoltage, 1)}
            currentPractical={cur(displayedSoc, 0)}
            domain={domain}
            yDomain={voltDomain}
            thresholds={voltageThresholds}
          />
          <SolarGenerationChart
            data={rows}
            currentSolar={cur(displayedReading?.pv_power, 0)}
            currentLoad={cur(
              displayedReading?.load_power == null
                ? null
                : displayedReading.load_power * 1000,
              0,
            )}
            domain={domain}
          />
          <MetricChart
            title="Grid voltage"
            data={rows}
            dataKey="gridV"
            color={gridVoltageColor}
            unit="V"
            digits={0}
            current={cur(gridVoltage, 0)}
            danger={{ from: 0, to: GRID_LOW_VOLTAGE_V }}
            domain={domain}
          />
          <div className="lg:col-span-2">
            <SolarLoadChart
              data={rows}
              currentPvToLoad={cur(displayedReading?.pv_to_load_kw, 1)}
              currentBattToLoad={cur(displayedReading?.battery_to_load_kw, 1)}
              currentGridToLoad={cur(displayedReading?.grid_to_load_kw, 1)}
              domain={domain}
            />
          </div>
        </div>
      )}
    </section>
  );
}
