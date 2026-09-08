import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Box, RotateCcw, RotateCw, ScanLine } from "lucide-react";
import {
  DEVICE_NAMES,
  type DeviceId,
  type EnergyConnection,
} from "../energyViewModel";
import { createHardware } from "./energyModels";
import { IconButton } from "./ui";

interface Props {
  connections: EnergyConnection[];
  selected: DeviceId;
  onSelect: (id: DeviceId) => void;
  soc: number | null;
  motion: boolean;
}
interface SceneActions {
  reset: () => void;
  rotate: () => void;
  top: () => void;
  update: () => void;
}
const IDS: DeviceId[] = ["solar", "grid", "inverter", "battery", "home"];
type Point = [number, number, number];

const ANCHORS: Record<DeviceId, Point> = {
  solar: [1.8, 3.25, 0.3],
  grid: [-4.6, 2.5, -0.75],
  inverter: [0.08, 1.25, 2.17],
  battery: [-1, 1.15, 2.17],
  home: [2.97, 1.4, 0.8],
};

function flowMaterial(length: number) {
  const uniforms = {
    flowTime: { value: 0 },
    flowDirection: { value: 1 },
    flowMoving: { value: 0 },
    flowRepeats: { value: Math.max(1, length / 0.85) },
  };
  // Keep standard lighting, depth and shadows. Only the light traveling along
  // the cable is emissive, so its body remains a shaded physical object.
  const material = new THREE.MeshStandardMaterial({
    color: "#393939",
    roughness: 0.46,
    metalness: 0.12,
    emissiveIntensity: 0.16,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      "varying vec2 cableUv;\n" +
      shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\ncableUv = uv;",
      );
    shader.fragmentShader =
      `
      varying vec2 cableUv;
      uniform float flowTime, flowDirection, flowMoving, flowRepeats;
    ` +
      shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `
      #include <emissivemap_fragment>
      float phase = fract(cableUv.x * flowRepeats - flowTime * 1.25 * flowDirection);
      float streak = smoothstep(0.65, 0.91, phase) * (1.0 - smoothstep(0.91, 1.0, phase));
      totalEmissiveRadiance += mix(diffuse, vec3(1.0), 0.85) * streak * flowMoving * 2.2;
    `,
      );
  };
  material.customProgramCacheKey = () => "installed-energy-cable-v2";
  return { material, uniforms };
}
export default function EnergyScene(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labels = useRef<Partial<Record<DeviceId, HTMLButtonElement | null>>>(
    {},
  );
  const leaders = useRef<Partial<Record<DeviceId, SVGPathElement | null>>>({});
  const dots = useRef<Partial<Record<DeviceId, SVGCircleElement | null>>>({});
  const current = useRef(props);
  current.current = props;
  const actions = useRef<SceneActions | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [topView, setTopView] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      setError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x101010, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-7, 7, 5, -5, 0.1, 100);
    const target = new THREE.Vector3(-0.5, 1.25, 0.6);
    camera.position.set(8, 9, 15);
    camera.lookAt(target);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = false;
    controls.minPolarAngle = 0.2;
    controls.maxPolarAngle = 1.15;
    controls.minAzimuthAngle = -0.2;
    controls.maxAzimuthAngle = 0.85;
    controls.enabled = window.matchMedia("(pointer: fine)").matches;
    function resetCameraPose() {
      camera.position.set(8, 9, 15);
      controls.target.copy(target);
      controls.update();
    }
    resetCameraPose();
    if (!controls.enabled) renderer.domElement.style.touchAction = "pan-y";
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 3.6);
    key.position.set(-4, 10, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, {
      left: -9,
      right: 9,
      top: 9,
      bottom: -9,
    });
    key.shadow.normalBias = 0.04;
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 2.2);
    rim.position.set(5, 6, -3);
    scene.add(rim);
    const hardware = createHardware();
    IDS.forEach((id) => scene.add(hardware.models[id]));
    scene.add(hardware.site);
    const wires = props.connections.map((connection) => {
      const curve = hardware.cables[connection.id];
      const { material, uniforms } = flowMaterial(curve.getLength());
      const geometry = new THREE.TubeGeometry(curve, 180, 0.036, 10, false);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      return {
        id: connection.id,
        material,
        uniforms,
        geometry,
      };
    });
    let width = 0,
      height = 0,
      compact = false;
    let frame = 0,
      disposed = false,
      contextLost = false,
      visible = true,
      needsDraw = true,
      lastFrame = 0;
    let view: "perspective" | "top" = "perspective";
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDown = { x: 0, y: 0 };
    let labelPositions: Record<DeviceId, [number, number]>;
    const projected = new THREE.Vector3();
    function positionLabels() {
      IDS.forEach((id) => {
        const element = labels.current[id];
        if (!element) return;
        const [x, y] = labelPositions[id];
        element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        projected.set(...ANCHORS[id]).project(camera);
        const px = (projected.x * 0.5 + 0.5) * width,
          py = (-projected.y * 0.5 + 0.5) * height;
        // The card covers the line's end; a fixed center avoids switching
        // attachment sides as the projected object crosses the card.
        leaders.current[id]?.setAttribute("d", `M ${px} ${py} L ${x} ${y}`);
        dots.current[id]?.setAttribute("cx", String(px));
        dots.current[id]?.setAttribute("cy", String(py));
      });
    }
    function draw(time = performance.now()) {
      if (disposed || contextLost) return;
      const state = current.current;
      hardware.chargeSegments.forEach((segment, i) => {
        segment.visible = state.soc != null && state.soc > i * 20;
      });
      wires.forEach((wire) => {
        const connection = state.connections.find((c) => c.id === wire.id)!;
        const forward = connection.from === wire.id;
        wire.material.color.set(
          connection.active ? connection.color : "#393939",
        );
        wire.material.emissive.set(
          connection.active ? connection.color : "#000000",
        );
        wire.uniforms.flowTime.value = time / 1000;
        wire.uniforms.flowDirection.value = forward ? 1 : -1;
        wire.uniforms.flowMoving.value =
          connection.active && state.motion ? 1 : 0;
      });
      // OrbitControls changes the pose before the renderer updates matrices.
      // Project callouts with that same pose, not the previous frame's camera.
      camera.updateMatrixWorld();
      positionLabels();
      renderer.render(scene, camera);
    }
    function tick(time: number) {
      frame = 0;
      if (disposed || contextLost || !visible || document.hidden) return;
      if (needsDraw || time - lastFrame > 1000 / 30) {
        draw(time);
        needsDraw = false;
        lastFrame = time;
      }
      if (
        current.current.motion &&
        current.current.connections.some((c) => c.active)
      )
        frame = requestAnimationFrame(tick);
    }
    function update() {
      if (disposed || contextLost || !visible || document.hidden) return;
      // Coalesce pointer events into one draw per display frame. Dragging is
      // never limited by the lower frame rate used for idle cable animation.
      needsDraw = true;
      if (!frame) frame = requestAnimationFrame(tick);
    }
    function frameCamera() {
      if (!width || !height) return;
      const aspect = width / height;
      const h = Math.max(compact ? 9.5 : 7.6, (compact ? 11.4 : 13.2) / aspect);
      camera.left = (-h * aspect) / 2;
      camera.right = (h * aspect) / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
    }
    function reset() {
      view = "perspective";
      setTopView(false);
      resetCameraPose();
      frameCamera();
      update();
    }
    function resize() {
      width = host!.clientWidth;
      height = host!.clientHeight;
      if (!width || !height) return;
      compact = width < 620;
      labelPositions = compact
        ? {
            grid: [width * 0.19, height * 0.22],
            solar: [width * 0.74, height * 0.13],
            inverter: [width * 0.53, height * 0.82],
            battery: [width * 0.18, height * 0.7],
            home: [width * 0.83, height * 0.67],
          }
        : {
            grid: [width * 0.15, height * 0.2],
            solar: [width * 0.73, height * 0.12],
            inverter: [width * 0.55, height * 0.86],
            battery: [width * 0.29, height * 0.79],
            home: [width * 0.87, height * 0.63],
          };
      renderer.setSize(width, height);
      frameCamera();
      update();
    }
    actions.current = {
      reset,
      update,
      rotate: () => {
        view = "perspective";
        setTopView(false);
        camera.position.set(camera.position.x > 6 ? 2 : 10, 9, 15);
        controls.update();
        update();
      },
      top: () => {
        if (view === "top") {
          reset();
          return;
        }
        view = "top";
        setTopView(true);
        camera.position.set(1, 22, 5);
        controls.update();
        update();
      },
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) update();
    });
    intersection.observe(host);
    const onVisibility = () => {
      if (!document.hidden) update();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(frame);
      setError(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (
        Math.hypot(
          event.clientX - pointerDown.x,
          event.clientY - pointerDown.y,
        ) > 7
      )
        return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(
        IDS.map((id) => hardware.models[id]),
        true,
      )[0];
      let object: THREE.Object3D | undefined = hit?.object;
      while (object) {
        if (object.userData.deviceId) {
          current.current.onSelect(object.userData.deviceId as DeviceId);
          break;
        }
        object = object.parent ?? undefined;
      }
    };
    controls.addEventListener("change", update);
    document.addEventListener("visibilitychange", onVisibility);
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    resize();
    setReady(true);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      actions.current = null;
      observer.disconnect();
      intersection.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener(
        "webglcontextlost",
        onContextLost,
      );
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      wires.forEach((w) => {
        w.geometry.dispose();
        w.material.dispose();
      });
      hardware.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    actions.current?.update();
  }, [props.connections, props.selected, props.soc, props.motion]);
  if (error)
    return (
      <div className="scene-fallback">
        <Box size={32} />
        <strong>3D view unavailable</strong>
        <div className="device-picker">
          {IDS.map((id) => (
            <button
              key={id}
              onClick={() => props.onSelect(id)}
              aria-pressed={props.selected === id}
            >
              {DEVICE_NAMES[id]}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="scene-wrap">
      <div
        className="scene-viewport installation-viewport"
        ref={hostRef}
        aria-label="3D energy installation"
        data-ready={ready}
        data-motion={props.motion}
      >
        {!ready && (
          <div className="scene-loading" role="status">
            Loading…
          </div>
        )}
        <svg
          className="installation-leaders"
          aria-hidden="true"
          style={{ visibility: ready ? "visible" : "hidden" }}
        >
          {IDS.map((id) => (
            <g key={id} className={props.selected === id ? "is-selected" : ""}>
              <path
                ref={(el) => {
                  leaders.current[id] = el;
                }}
              />
              <circle
                r="2.5"
                ref={(el) => {
                  dots.current[id] = el;
                }}
              />
            </g>
          ))}
        </svg>
        <div
          className="scene-label-layer"
          style={{ visibility: ready ? "visible" : "hidden" }}
        >
          {IDS.map((id) => {
            const connection = props.connections.find((c) => c.id === id);
            return (
              <button
                key={id}
                ref={(el) => {
                  labels.current[id] = el;
                }}
                className={`device-label installation-label ${props.selected === id ? "is-selected" : ""}`}
                aria-pressed={props.selected === id}
                aria-controls="device-inspector"
                onClick={() => props.onSelect(id)}
                style={
                  {
                    "--flow-color": connection?.color ?? "#dedede",
                  } as CSSProperties
                }
              >
                <span>{DEVICE_NAMES[id]}</span>
                <strong>
                  {id === "battery"
                    ? props.soc == null
                      ? "—"
                      : `${Math.round(props.soc)}%`
                    : (connection?.value ?? "DC / AC")}
                </strong>
                {connection?.flowDetail && (
                  <span className="battery-flow-detail">
                    {connection.flowDetail}
                  </span>
                )}
                {connection && (
                  <small>
                    {connection.minimum
                      ? "Estimated minimum"
                      : connection.inferred
                        ? "Estimated power"
                        : connection.label}
                  </small>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="scene-bottom">
        <div className="scene-controls">
          <IconButton
            label="Rotate view"
            onClick={() => actions.current?.rotate()}
          >
            <RotateCw size={15} />
          </IconButton>
          <IconButton
            label={topView ? "Perspective view" : "Top view"}
            aria-pressed={topView}
            onClick={() => actions.current?.top()}
          >
            {topView ? <Box size={15} /> : <ScanLine size={15} />}
          </IconButton>
          <IconButton
            label="Reset view"
            onClick={() => actions.current?.reset()}
          >
            <RotateCcw size={15} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
