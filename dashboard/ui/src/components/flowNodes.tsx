/**
 * Shared power-flow building blocks used by both the live dashboard
 * (EnergyFlow) and the temporary design lab (NodeLab).
 *
 * - Node cards: five internal layouts, all flat-dark theme, prop-driven.
 * - FlowDiagram: a responsive SVG that draws idle/active links (with number
 *   labels, colored by source) and hosts the HTML node cards via <foreignObject>
 *   so the whole scene scales uniformly without distorting the link curves.
 */
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { C, FONT } from "../theme";

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export function FlowChip({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
  return (
    <span className="fnode-chip" style={{ color }}>
      <Icon size={13} strokeWidth={1.9} />
    </span>
  );
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
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="fnode-ring__svg">
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

const accent = (color: string) => ({ "--accent": color }) as CSSProperties;

/* ------------------------------------------------------------------ *
 * Variant 1 — Stacked centered
 * ------------------------------------------------------------------ */

export interface StackNodeProps extends BaseProps {
  value: string;
  unit?: string;
  sub?: string;
}

export function StackNode({ label, icon, color, active, value, unit, sub }: StackNodeProps) {
  return (
    <div className={`fnode fnode--stack${active ? " is-active" : ""}`} style={accent(color)}>
      <div className="fnode__corner">
        <FlowChip icon={icon} color={active ? color : C.textDim} />
        <span className="fnode__label">{label}</span>
      </div>
      <span className="fnode__dot" style={{ background: active ? color : C.line }} />
      <div className="fnode__center">
        <div className="fnode__value mono" style={active ? { color } : undefined}>
          {value}
          {unit && <small>{unit}</small>}
        </div>
        {sub && <div className="fnode__sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 2 — Header bar + key/value metric grid
 * ------------------------------------------------------------------ */

export interface SplitNodeProps extends BaseProps {
  value: string;
  unit?: string;
  pill?: string;
  kv?: { k: string; v: string }[];
}

export function SplitNode({ label, icon, color, active, value, unit, pill, kv }: SplitNodeProps) {
  return (
    <div className={`fnode fnode--split${active ? " is-active" : ""}`} style={accent(color)}>
      <div className="fnode__bar">
        <FlowChip icon={icon} color={active ? color : C.textDim} />
        <span className="fnode__label">{label}</span>
        {pill && (
          <span
            className="fnode-pill"
            style={{ color: active ? color : C.textDim, borderColor: active ? color : C.lineHi }}
          >
            {pill}
          </span>
        )}
      </div>
      <div className="fnode__body">
        <div className="fnode__value mono" style={active ? { color } : undefined}>
          {value}
          {unit && <small>{unit}</small>}
        </div>
        {kv && kv.length > 0 && (
          <div className="fnode-kv">
            {kv.map((cell) => (
              <div className="fnode-kv__cell" key={cell.k}>
                <span>{cell.k}</span>
                <b className="mono">{cell.v}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 3 — Accent rail + inline bar meter
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
    <div className={`fnode fnode--rail${active ? " is-active" : ""}`} style={accent(color)}>
      <div className="fnode__head">
        <FlowChip icon={icon} color={active ? color : C.textDim} />
        <span className="fnode__label">{label}</span>
        {right && <span className="fnode__head-right mono">{right}</span>}
      </div>
      <div className="fnode__value mono" style={active ? { color } : undefined}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {meterPct != null && (
        <div className="fnode-meter">
          <i style={{ width: `${Math.min(100, Math.max(0, meterPct))}%`, background: color }} />
        </div>
      )}
      {cap && <div className="fnode__cap">{cap}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 4 — Ring gauge + side readout
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
    <div className={`fnode fnode--ring${active ? " is-active" : ""}`} style={accent(color)}>
      <div className="fnode-ring">
        <FlowRing pct={pct} color={ringColor} />
        <div className="fnode-ring__center">
          <span className="fnode-ring__pct mono">{pct != null ? Math.round(pct) : "—"}</span>
          {pct != null && <span className="fnode-ring__unit">%</span>}
        </div>
      </div>
      <div className="fnode-ring__side">
        <div className="fnode__head">
          <FlowChip icon={icon} color={ringColor} />
          <span className="fnode__label">{label}</span>
        </div>
        {sub && (
          <div className="fnode__sub" style={active ? { color } : undefined}>
            {sub}
          </div>
        )}
        {metric && (
          <div className="fnode-ring__metric mono">
            {metric}
            {metricUnit && <small>{metricUnit}</small>}
          </div>
        )}
        {caps?.map((c, i) => (
          <div className="fnode__cap" key={i}>
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Variant 5 — Dense telemetry readout (lab specimen)
 * ------------------------------------------------------------------ */

export interface TelemetryNodeProps extends BaseProps {
  rows: { k: string; v: string; u?: string }[];
  bars?: number[];
}

export function TelemetryNode({ label, icon, color, active, rows, bars }: TelemetryNodeProps) {
  return (
    <div className={`fnode fnode--telemetry${active ? " is-active" : ""}`} style={accent(color)}>
      <div className="fnode__head">
        <FlowChip icon={icon} color={active ? color : C.textDim} />
        <span className="fnode__label">{label}</span>
        <span className="fnode__dot" style={{ background: active ? color : C.line }} />
      </div>
      <div className="fnode-readout">
        {rows.map((r) => (
          <div className="fnode-readout__row" key={r.k}>
            <span>{r.k}</span>
            <b className="mono">
              {r.v}
              {r.u && <small>{r.u}</small>}
            </b>
          </div>
        ))}
      </div>
      {bars && bars.length > 0 && (
        <div className="fnode-spark" aria-hidden>
          {bars.map((h, i) => (
            <i key={i} style={{ height: `${h * 100}%`, background: color }} />
          ))}
        </div>
      )}
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
        fill="#0a0c0d"
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
  className = "",
}: {
  width?: number;
  height?: number;
  nodes: DiagramNode[];
  links: DiagramLink[];
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`flow-diagram ${className}`.trim()}
      preserveAspectRatio="xMidYMid meet"
    >
      {links.map((l) => (
        <path
          key={l.id}
          className={`flow-link${l.active ? " is-active" : ""}`}
          d={l.path}
          style={l.active ? { stroke: l.color } : undefined}
        />
      ))}
      {links.map((l) => (
        <LinkLabel key={`lbl-${l.id}`} link={l} />
      ))}
      {nodes.map((n) => (
        <foreignObject key={n.id} x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h}>
          <div className="fnode-host">{n.el}</div>
        </foreignObject>
      ))}
    </svg>
  );
}
