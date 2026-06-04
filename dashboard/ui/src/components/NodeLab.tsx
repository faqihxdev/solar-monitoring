/**
 * TEMPORARY design-lab route (open the dashboard at `#/nodelab`).
 *
 * Showcases the five power-flow node layouts, the two link states (idle /
 * active flow, colored by source), and a combined scene that renders with the
 * exact same FlowDiagram used by the live dashboard — just fed sample data.
 * Delete this file (and the `#/nodelab` branch in main.tsx) once done.
 */
import {
  Battery,
  Plug,
  Sun,
  Zap,
  Workflow,
  Cpu,
  ArrowLeft,
} from "lucide-react";
import { C } from "../theme";
import {
  FlowDiagram,
  RailNode,
  RingNode,
  SplitNode,
  StackNode,
  TelemetryNode,
  type DiagramLink,
  type DiagramNode,
} from "./flowNodes";

/* ------------------------------------------------------------------ *
 * Sample specimens for the variant gallery
 * ------------------------------------------------------------------ */

const SPECIMENS: { n: string; name: string; note: string; render: () => JSX.Element }[] = [
  {
    n: "01",
    name: "Stacked centered",
    note: "Icon + label pinned top-left, value centered in the card, status caption below. Calm and scannable.",
    render: () => (
      <StackNode label="Solar" icon={Sun} color={C.solar} active value="1.24" unit="kW" sub="To load + batt" />
    ),
  },
  {
    n: "02",
    name: "Header / metrics",
    note: "Title bar with a state pill, divider, then a 2-up key/value grid for secondary numbers.",
    render: () => (
      <SplitNode
        label="Grid"
        icon={Plug}
        color={C.grid}
        active
        value="230"
        unit="V"
        pill="Mains"
        kv={[
          { k: "Import", v: "0.42 kW" },
          { k: "To batt", v: "—" },
        ]}
      />
    ),
  },
  {
    n: "03",
    name: "Accent rail + meter",
    note: "Colored left rail for identity, headline value, and an inline bar meter for proportion.",
    render: () => (
      <RailNode
        label="Load"
        icon={Zap}
        color={C.load}
        active
        value="0.86"
        unit="kW"
        right="3.7 A"
        meterPct={43}
        cap="43% of 2.0 kW peak"
      />
    ),
  },
  {
    n: "04",
    name: "Ring gauge",
    note: "Circular gauge pairs a percentage with a side readout. Ideal for the battery / SOC node.",
    render: () => (
      <RingNode
        label="Battery"
        icon={Battery}
        color={C.charge}
        active
        pct={78}
        sub="Charging"
        metric="52.3"
        metricUnit="V"
        caps={["Practical 78% · Reported 81%", "ETA 1h 40m"]}
      />
    ),
  },
  {
    n: "05",
    name: "Dense telemetry",
    note: "Compact multi-row readout plus a mini bar strip. For diagnostics-heavy nodes.",
    render: () => (
      <TelemetryNode
        label="Inverter"
        icon={Cpu}
        color={C.battery}
        active
        rows={[
          { k: "PV", v: "1.24", u: "kW" },
          { k: "Batt", v: "52.3", u: "V" },
          { k: "Load", v: "0.86", u: "kW" },
          { k: "Temp", v: "41", u: "°C" },
        ]}
        bars={[0.6, 0.9, 0.45, 0.3, 0.75, 0.55, 0.85, 0.4]}
      />
    ),
  },
];

/* ------------------------------------------------------------------ *
 * Link state gallery — idle + active flow (colored per source)
 * ------------------------------------------------------------------ */

const DEMO_PATH = "M 22 28 C 90 28, 150 28, 218 28";

function DemoSvg({ children }: { children: JSX.Element }) {
  return (
    <svg viewBox="0 0 240 56" className="nlab-link-svg" preserveAspectRatio="xMidYMid meet">
      <rect className="nlab-anchor" x={6} y={20} width={16} height={16} rx={3} />
      <rect className="nlab-anchor" x={218} y={20} width={16} height={16} rx={3} />
      {children}
    </svg>
  );
}

const ACTIVE_COLORS = [C.solar, C.grid, C.discharge, C.charge];

/* ------------------------------------------------------------------ *
 * Combined scene — sample data through the real FlowDiagram
 * ------------------------------------------------------------------ */

const SCENE_BOX = {
  solar: { x: 24, y: 20, w: 250, h: 92 },
  grid: { x: 24, y: 188, w: 250, h: 92 },
  battery: { x: 398, y: 101, w: 244, h: 98 },
  load: { x: 766, y: 104, w: 244, h: 92 },
};

const SCENE_NODES: DiagramNode[] = [
  {
    id: "solar",
    box: SCENE_BOX.solar,
    el: <StackNode label="Solar" icon={Sun} color={C.solar} active value="1.24" unit="kW" sub="To load + batt" />,
  },
  {
    id: "grid",
    box: SCENE_BOX.grid,
    el: <StackNode label="Grid" icon={Plug} color={C.grid} value="230" unit="V" sub="Standby" />,
  },
  {
    id: "battery",
    box: SCENE_BOX.battery,
    el: (
      <RingNode
        label="Battery"
        icon={Battery}
        color={C.charge}
        active
        pct={78}
        sub="Charging"
        metric="52.3"
        metricUnit="V"
        caps={["ETA 1h 40m to A6/24.0V"]}
      />
    ),
  },
  {
    id: "load",
    box: SCENE_BOX.load,
    el: (
      <RailNode
        label="Load"
        icon={Zap}
        color={C.load}
        active
        value="0.86"
        unit="kW"
        right="3.7 A"
        meterPct={43}
        cap="43% of 1.2 kW max"
      />
    ),
  },
];

const SCENE_LINKS: DiagramLink[] = [
  { id: "pv-batt", path: "M 274 84 C 330 84, 350 132, 398 132", active: true, color: C.solar, label: "310", at: { x: 339, y: 108 } },
  { id: "grid-batt", path: "M 274 216 C 330 216, 350 168, 398 168", active: false, color: C.grid },
  { id: "batt-load", path: "M 642 150 L 766 150", active: true, color: C.discharge, label: "0.86k", at: { x: 704, y: 150 } },
  { id: "pv-load", path: "M 274 48 C 460 14, 580 14, 766 130", active: true, color: C.solar, label: "0.93k", at: { x: 520, y: 33 } },
  { id: "grid-load", path: "M 274 254 C 460 290, 580 290, 766 170", active: false, color: C.grid },
];

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function NodeLab() {
  return (
    <div className="app nlab">
      <header className="nlab-head">
        <div className="brand">
          <div className="brand__mark">
            <Workflow size={20} strokeWidth={1.8} />
          </div>
          <div>
            <div className="brand__title">
              Node <span>Lab</span>
            </div>
            <div className="brand__id">Experimental power-flow components · temporary route</div>
          </div>
        </div>
        <a className="nlab-back" href="#/">
          <ArrowLeft size={14} strokeWidth={1.9} /> Back to dashboard
        </a>
      </header>

      <section className="section">
        <div className="section-head">
          <h2>
            <Workflow size={14} strokeWidth={1.8} /> Node variants
          </h2>
          <span className="note">5 internal layouts · sample data</span>
        </div>
        <div className="nlab-grid">
          {SPECIMENS.map((v) => (
            <article className="nlab-spec" key={v.n}>
              <div className="nlab-spec__frame">{v.render()}</div>
              <div className="nlab-spec__meta">
                <div className="nlab-spec__title">
                  <span className="nlab-spec__num mono">{v.n}</span> {v.name}
                </div>
                <p className="nlab-spec__note">{v.note}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Workflow size={14} strokeWidth={1.8} /> Link states
          </h2>
          <span className="note">idle + active flow · flat strokes</span>
        </div>
        <div className="nlab-links-grid">
          <article className="nlab-link-card">
            <div className="nlab-link-card__demo">
              <DemoSvg>
                <path className="flow-link" d={DEMO_PATH} />
              </DemoSvg>
            </div>
            <div className="nlab-link-card__title">Idle</div>
            <p className="nlab-link-card__desc">
              No measurable flow. Dim and static so live paths stand out.
            </p>
          </article>

          <article className="nlab-link-card">
            <div className="nlab-link-card__demo">
              <DemoSvg>
                <g>
                  {ACTIVE_COLORS.map((color, i) => {
                    const y = 12 + i * 11;
                    return (
                      <path
                        key={color}
                        className="flow-link is-active"
                        d={`M 22 ${y} C 90 ${y}, 150 ${y}, 218 ${y}`}
                        style={{ stroke: color }}
                      />
                    );
                  })}
                </g>
              </DemoSvg>
            </div>
            <div className="nlab-link-card__title">Active flow</div>
            <p className="nlab-link-card__desc">
              Marching dashes show direction; the stroke is colored by source — solar, grid,
              battery discharge.
            </p>
          </article>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Workflow size={14} strokeWidth={1.8} /> Combined scene
          </h2>
          <span className="note">sample data · live FlowDiagram</span>
        </div>
        <div className="panel flow nlab-scene-panel">
          <FlowDiagram className="flow__svg" width={1034} height={300} nodes={SCENE_NODES} links={SCENE_LINKS} />
        </div>
      </section>
    </div>
  );
}
