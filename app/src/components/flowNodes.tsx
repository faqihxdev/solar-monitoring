/**
 * Shared power-flow building blocks used by the live dashboard (EnergyFlow).
 *
 * - Node cards: flat-dark layouts, prop-driven.
 * - FlowDiagram: a responsive SVG that draws idle/active links (with number
 *   labels, colored by source) and hosts the HTML node cards via <foreignObject>
 *   so the whole scene scales uniformly without distorting the link curves.
 */
import type { LucideIcon } from "lucide-react";
import { C, FONT } from "../theme";

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export function FlowChip({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
  return <Icon className="shrink-0" size={14} strokeWidth={1.9} style={{ color }} />;
}

export function FlowRing({
  pct,
  color,
  size = 70,
}: {
  pct: number | null;
  color: string;
  size?: number;
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct ?? 0)) / 100) * circ;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.line} strokeWidth={stroke} />
      {pct != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

interface BaseProps {
  label: string;
  icon: LucideIcon;
  color: string;
  active?: boolean;
}

/* ------------------------------------------------------------------ *
 * Variant 1 — Stacked centered
 * ------------------------------------------------------------------ */

export interface StackNodeProps extends BaseProps {
  value: string;
  unit?: string;
  sub?: string;
  /** Forces warning emphasis even when the node is otherwise idle. */
  alert?: boolean;
}

export function StackNode({ label, icon, color, active, value, unit, sub, alert }: StackNodeProps) {
  const highlight = Boolean(active || alert);
  return (
    <div className="relative flex min-h-20 w-full items-center justify-center rounded-card border border-line-hi bg-panel-hi px-3 py-2.5 text-center">
      <div className="absolute left-3 top-2.5 flex items-center gap-1.5">
        <FlowChip icon={icon} color={highlight ? color : C.textDim} />
        <span className="text-xs font-semibold uppercase tracking-wider text-dim">{label}</span>
      </div>
      <span className="absolute right-3 top-3 h-1.5 w-1.5 rounded-full" style={{ background: highlight ? color : C.line }} />
      <div className="flex flex-col items-center gap-1 mt-2">
        <div
          className="font-mono text-2xl font-medium leading-none tracking-tight tabular-nums text-text"
          style={highlight ? { color } : undefined}
        >
          {value}
          {unit && <small className="ml-1 text-xs font-normal text-dim">{unit}</small>}
        </div>
        {sub && <div className="text-xs uppercase tracking-wider text-faint">{sub}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 2 — Accent rail + inline bar meter
 * ------------------------------------------------------------------ */

export interface RailNodeProps extends BaseProps {
  value: string;
  unit?: string;
  right?: string;
  meterPct?: number | null;
  cap?: string;
}

export function RailNode({
  label,
  icon,
  color,
  active,
  value,
  unit,
  right,
  meterPct,
  cap,
}: RailNodeProps) {
  return (
    <div className="flex w-full flex-col justify-center gap-2 rounded-card border border-line-hi bg-panel-hi px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <FlowChip icon={icon} color={active ? color : C.textDim} />
        <span className="text-xs font-semibold uppercase tracking-wider text-dim">{label}</span>
        {right && <span className="ml-auto font-mono text-xs text-dim">{right}</span>}
      </div>
      <div
        className="font-mono text-base font-medium leading-none tracking-tight tabular-nums text-text"
        style={active ? { color } : undefined}
      >
        {value}
        {unit && <small className="ml-1 text-xs font-normal text-dim">{unit}</small>}
      </div>
      {meterPct != null && (
        <div className="h-1.5 overflow-hidden rounded bg-line">
          <i
            className="block h-full rounded"
            style={{ width: `${Math.min(100, Math.max(0, meterPct))}%`, background: color }}
          />
        </div>
      )}
      {cap && <div className="text-[10px] leading-tight tracking-wide text-faint">{cap}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 3 — Ring gauge + side readout
 * ------------------------------------------------------------------ */

export interface RingNodeProps extends BaseProps {
  pct: number | null;
  sub?: string;
  metric?: string;
  metricUnit?: string;
  caps?: string[];
}

export function RingNode({
  label,
  icon,
  color,
  active,
  pct,
  sub,
  metric,
  metricUnit,
  caps,
}: RingNodeProps) {
  const ringColor = active ? color : C.textDim;
  return (
    <div className="flex w-full items-center gap-3 rounded-card border border-line-hi bg-panel-hi px-3 py-2">
      <div className="relative grid shrink-0 place-items-center">
        <FlowRing pct={pct} color={ringColor} />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-base font-medium tabular-nums text-text">
            {pct != null ? Math.round(pct) : "—"}
          </span>
          {pct != null && <span className="ml-px text-xs text-dim">%</span>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <FlowChip icon={icon} color={ringColor} />
          <span className="text-xs font-semibold uppercase tracking-wider text-dim">{label}</span>
        </div>
        {sub && (
          <div className="text-[10px] uppercase tracking-wider text-faint" style={active ? { color } : undefined}>
            {sub}
          </div>
        )}
        {metric && (
          <div className="font-mono text-sm tabular-nums text-text">
            {metric}
            {metricUnit && <small className="ml-0.5 text-xs text-dim">{metricUnit}</small>}
          </div>
        )}
        {caps?.map((c, i) => (
          <div className="truncate whitespace-nowrap text-[10px] leading-tight tracking-wide text-faint" key={i} title={c}>
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * FlowDiagram — links (idle / active) + foreignObject node hosts
 * ------------------------------------------------------------------ */

export interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramNode {
  id: string;
  box: DiagramBox;
  el: JSX.Element;
}

export interface DiagramLink {
  id: string;
  path: string;
  active: boolean;
  color: string;
  /** Optional number/label shown at `at` when the link is active. */
  label?: string;
  at?: { x: number; y: number };
}

function LinkLabel({ link }: { link: DiagramLink }) {
  if (!link.label || !link.at) return null;
  const w = link.label.length * 7 + 14;
  return (
    <g>
      <rect
        x={link.at.x - w / 2}
        y={link.at.y - 9}
        width={w}
        height={18}
        rx={3}
        fill={C.bg}
        stroke={C.line}
      />
      <text
        x={link.at.x}
        y={link.at.y + 3}
        textAnchor="middle"
        fontFamily={FONT.mono}
        fontSize={12}
        fill={link.color}
      >
        {link.label}
      </text>
    </g>
  );
}

export function FlowDiagram({
  width = 720,
  height = 360,
  nodes,
  links,
}: {
  width?: number;
  height?: number;
  nodes: DiagramNode[];
  links: DiagramLink[];
}) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {links.map((l) => (
        <path
          key={l.id}
          className="fill-none"
          d={l.path}
          style={{
            stroke: l.active ? l.color : C.lineHi,
            opacity: l.active ? 1 : 0.4,
            strokeLinecap: "round",
            strokeWidth: l.active ? 2.6 : 2,
            strokeDasharray: l.active ? "5 6" : undefined,
            animation: l.active ? "flowdash 0.9s linear infinite" : undefined,
          }}
        />
      ))}
      {links.map((l) => (
        <LinkLabel key={`lbl-${l.id}`} link={l} />
      ))}
      {nodes.map((n) => (
        <foreignObject key={n.id} x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} overflow="hidden">
          <div className="h-full w-full overflow-hidden">
            {n.el}
          </div>
        </foreignObject>
      ))}
    </svg>
  );
}
