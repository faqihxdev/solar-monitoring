import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { DeviceId, EnergyConnection } from "../energyViewModel";
import { C } from "../theme";
import {
  DeviceCallout,
  SCENE_DEVICE_IDS as IDS,
  type SceneProps,
} from "./DeviceCallout";

type Point = [number, number];

const WIDTH = 1000;
const HEIGHT = 520;
// Every cable path starts at its device and ends at the inverter. Bends are
// quadratic curves so the cables and their flow pulses have no hard corners.
const CABLES: Record<EnergyConnection["id"], string> = {
  solar:
    "M 806 232 L 806 268 Q 806 280 794 280 L 600 280 Q 588 280 588 292 L 588 305",
  grid: "M 212 172 Q 320 262 420 270 L 550 270 Q 562 270 562 282 L 562 305",
  battery: "M 495 390 Q 495 397 502 397 L 568 397 Q 575 397 575 390 L 575 380",
  home: "M 673 336 L 673 340 Q 673 350 663 350 L 600 350",
};
const ANCHORS: Record<DeviceId, Point> = {
  solar: [740, 185],
  grid: [170, 205],
  inverter: [575, 342],
  battery: [495, 340],
  // The AC distribution box, where the home circuit starts.
  home: [673, 318],
};
const LABELS: Record<DeviceId, Point> = {
  solar: [880, 80],
  grid: [80, 90],
  inverter: [640, 462],
  battery: [420, 462],
  home: [860, 462],
};

function FlowCable({
  d,
  connection,
  motion,
}: {
  d: string;
  connection: EnergyConnection | undefined;
  motion: boolean;
}) {
  return (
    <g>
      <path d={d} className="flat-cable-base" />
      {connection?.active && (
        <path
          d={d}
          className="flat-cable-pulse"
          style={{
            stroke: connection.color,
            animationDirection:
              connection.from === connection.id ? "normal" : "reverse",
            animationPlayState: motion ? "running" : "paused",
          }}
        />
      )}
    </g>
  );
}

// A flat side view of the installation: pole, house, roof panel, and the
// battery, inverter and AC board on the front wall.
export default function FlatScene(props: SceneProps) {
  const soc = Math.max(0, Math.min(100, props.soc ?? 0));
  const select = (id: DeviceId) => ({ onClick: () => props.onSelect(id) });
  const scene = useRef<HTMLDivElement>(null);
  const labels = useRef<Partial<Record<DeviceId, HTMLButtonElement | null>>>(
    {},
  );
  // Labels are centered on fixed points; shift any that would cross the scene edge.
  useLayoutEffect(() => {
    const container = scene.current;
    if (!container) return;
    const fit = () => {
      const width = container.clientWidth;
      for (const id of IDS) {
        const label = labels.current[id];
        if (!label) continue;
        const center = (LABELS[id][0] / WIDTH) * width;
        const half = label.offsetWidth / 2;
        const inside = Math.min(Math.max(center, half + 4), width - half - 4);
        label.style.setProperty("--fit-x", `${inside - center}px`);
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    for (const label of Object.values(labels.current)) {
      if (label) observer.observe(label);
    }
    return () => observer.disconnect();
  }, [props.connections, props.soc]);
  return (
    <div className="scene-wrap flat-scene-wrap">
      <div
        className="flat-scene"
        aria-label="Energy installation diagram"
        ref={scene}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="flat-scene-svg"
          aria-hidden="true"
        >
          <rect
            x="0"
            y="400"
            width="1000"
            height="10"
            rx="5"
            className="flat-ground"
          />
          <g className="flat-device" {...select("grid")}>
            <line x1="170" y1="400" x2="170" y2="140" className="flat-pole" />
            <line x1="122" y1="170" x2="218" y2="170" className="flat-arm" />
            <line x1="134" y1="200" x2="206" y2="200" className="flat-arm" />
          </g>
          <g className="flat-device" {...select("home")}>
            <rect
              x="420"
              y="250"
              width="400"
              height="150"
              className="flat-wall"
            />
            {/* Drawn after the wall so the eave overhangs and covers its top. */}
            <polygon points="400,250 620,135 840,250" className="flat-roof" />
            {/* Rounded only at the top; the door's bottom edge meets the ground. */}
            <path
              d="M 740 400 V 326 Q 740 320 746 320 H 774 Q 780 320 780 326 V 400 Z"
              className="flat-door"
            />
            <rect
              x="660"
              y="300"
              width="26"
              height="36"
              rx="5"
              className="flat-box"
            />
          </g>
          <g className="flat-device" {...select("solar")}>
            <line x1="668" y1="151" x2="811" y2="226" className="flat-panel" />
          </g>
          <g className="flat-device" {...select("battery")}>
            <rect
              x="470"
              y="320"
              width="50"
              height="70"
              rx="6"
              className="flat-battery"
            />
            <rect
              x="478"
              y={382 - (54 * soc) / 100}
              width="34"
              height={(54 * soc) / 100}
              rx="2"
              style={{ fill: C.charge }}
            />
          </g>
          <g className="flat-device" {...select("inverter")}>
            <rect
              x="550"
              y="305"
              width="50"
              height="75"
              rx="6"
              className="flat-inverter"
            />
            <rect
              x="560"
              y="318"
              width="30"
              height="16"
              rx="2"
              className="flat-screen"
            />
          </g>
          {(Object.keys(CABLES) as EnergyConnection["id"][]).map((id) => (
            <FlowCable
              key={id}
              d={CABLES[id]}
              connection={props.connections.find((c) => c.id === id)}
              motion={props.motion}
            />
          ))}
          {IDS.map((id) => (
            <g
              key={id}
              className={`flat-leader ${props.selected === id ? "is-selected" : ""}`}
            >
              <line
                x1={ANCHORS[id][0]}
                y1={ANCHORS[id][1]}
                x2={LABELS[id][0]}
                y2={LABELS[id][1]}
              />
              <circle cx={ANCHORS[id][0]} cy={ANCHORS[id][1]} r="3" />
            </g>
          ))}
        </svg>
        {IDS.map((id) => {
          const connection = props.connections.find((c) => c.id === id);
          return (
            <button
              key={id}
              ref={(el) => {
                labels.current[id] = el;
              }}
              className={`device-label installation-label flat-label ${props.selected === id ? "is-selected" : ""}`}
              aria-pressed={props.selected === id}
              aria-controls="device-inspector"
              onClick={() => props.onSelect(id)}
              style={
                {
                  left: `${(LABELS[id][0] / WIDTH) * 100}%`,
                  top: `${(LABELS[id][1] / HEIGHT) * 100}%`,
                  "--flow-color": connection?.color ?? "#dedede",
                } as CSSProperties
              }
            >
              <DeviceCallout
                id={id}
                connections={props.connections}
                soc={props.soc}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
