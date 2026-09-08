import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { DeviceId } from "../energyViewModel";

function roundedCable(points: THREE.Vector3[]) {
  const curve = new THREE.CurvePath<THREE.Vector3>();
  let last = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const radius = Math.min(
      0.1,
      point.distanceTo(points[i - 1]) / 3,
      point.distanceTo(points[i + 1]) / 3,
    );
    const before = point
      .clone()
      .add(points[i - 1].clone().sub(point).normalize().multiplyScalar(radius));
    const after = point
      .clone()
      .add(points[i + 1].clone().sub(point).normalize().multiplyScalar(radius));
    curve.add(new THREE.LineCurve3(last, before));
    curve.add(new THREE.QuadraticBezierCurve3(before, point, after));
    last = after;
  }
  curve.add(new THREE.LineCurve3(last, points[points.length - 1]));
  return curve;
}

// These models are built locally from geometry. No external models or textures.
export function createHardware() {
  const materials = {
    shell: new THREE.MeshStandardMaterial({
      color: "#b7b7b7",
      roughness: 0.34,
      metalness: 0.5,
    }),
    face: new THREE.MeshStandardMaterial({
      color: "#787878",
      roughness: 0.45,
      metalness: 0.3,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: "#242424",
      roughness: 0.55,
      metalness: 0.25,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: "#555555",
      roughness: 0.3,
      metalness: 0.7,
    }),
    cell: new THREE.MeshStandardMaterial({
      color: "#263039",
      roughness: 0.24,
      metalness: 0.6,
    }),
    wall: new THREE.MeshStandardMaterial({ color: "#606060", roughness: 0.85 }),
    roof: new THREE.MeshStandardMaterial({
      color: "#373737",
      roughness: 0.65,
      metalness: 0.25,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: "#657276",
      emissive: "#929f9b",
      emissiveIntensity: 0.15,
      roughness: 0.25,
      metalness: 0.5,
    }),
    light: new THREE.MeshStandardMaterial({
      color: "#bdcdbb",
      emissive: "#a3bda5",
      emissiveIntensity: 0.8,
    }),
    screen: new THREE.MeshStandardMaterial({
      color: "#101b18",
      roughness: 0.4,
    }),
    pad: new THREE.MeshStandardMaterial({
      color: "#1a1a1a",
      roughness: 0.85,
      metalness: 0.1,
    }),
  };
  type MaterialKey = keyof typeof materials;
  const geometries: THREE.BufferGeometry[] = [];
  function box(
    parent: THREE.Object3D,
    size: [number, number, number],
    position: [number, number, number],
    material: MaterialKey,
    radius = 0,
  ) {
    const geometry = radius
      ? new RoundedBoxGeometry(...size, 2, radius)
      : new THREE.BoxGeometry(...size);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, materials[material]);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function strut(
    parent: THREE.Object3D,
    a: number[],
    b: number[],
    radius = 0.025,
    material: MaterialKey = "trim",
  ) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(
      radius,
      radius,
      direction.length(),
      6,
    );
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, materials[material]);
    mesh.position.copy(start.add(end).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // The cable endpoint sits inside a real gland. Both its position and exit
  // direction inherit the equipment transform, including scale and rotation.
  function port(
    parent: THREE.Object3D,
    position: [number, number, number],
    outward: [number, number, number],
  ) {
    const origin = new THREE.Vector3(...position);
    const direction = new THREE.Vector3(...outward).normalize();
    const at = (distance: number) =>
      origin.clone().addScaledVector(direction, distance);
    strut(parent, at(-0.025).toArray(), at(0.04).toArray(), 0.09, "trim");
    strut(parent, at(0.03).toArray(), at(0.12).toArray(), 0.067, "dark");
    strut(parent, at(0.085).toArray(), at(0.125).toArray(), 0.074, "face");
    const socket = new THREE.Object3D();
    socket.position.copy(at(0.11));
    const lead = new THREE.Object3D();
    lead.position.copy(at(0.23));
    parent.add(socket, lead);
    return {
      point: () => socket.getWorldPosition(new THREE.Vector3()),
      exit: () => lead.getWorldPosition(new THREE.Vector3()),
    };
  }
  const models = Object.fromEntries(
    (["solar", "inverter", "battery", "home", "grid"] as DeviceId[]).map(
      (id) => {
        const group = new THREE.Group();
        group.userData.deviceId = id;
        return [id, group];
      },
    ),
  ) as Record<DeviceId, THREE.Group>;

  const solar = new THREE.Group();
  models.solar.add(solar);
  const panel = new THREE.Group();
  panel.position.set(0, 0, 0);
  solar.add(panel);
  box(panel, [2.36, 0.08, 1.53], [0, 0, 0], "shell", 0.02);
  for (let col = 0; col < 6; col++)
    for (let row = 0; row < 3; row++) {
      const x = -0.97 + col * 0.388,
        z = -0.49 + row * 0.49;
      box(panel, [0.366, 0.025, 0.465], [x, 0.055, z], "cell", 0.009);
      box(panel, [0.005, 0.006, 0.45], [x, 0.07, z], "trim");
    }
  // Cable leaves a junction box fixed to the frame, clear of the solar cells.
  box(panel, [0.34, 0.17, 0.2], [0, -0.035, 0.82], "dark", 0.025);
  box(panel, [0.27, 0.03, 0.15], [0, 0.06, 0.82], "face", 0.012);
  const solarPort = port(panel, [0, -0.035, 0.92], [0, 0, 1]);

  const battery = new THREE.Group();
  battery.rotation.y = 0;
  models.battery.add(battery);
  box(battery, [1.23, 1.86, 0.66], [0, 1.07, 0], "dark", 0.12);
  box(battery, [1.12, 1.71, 0.13], [0, 1.08, 0.33], "shell", 0.08);
  box(battery, [0.87, 0.16, 0.04], [0, 1.72, 0.412], "dark", 0.025);
  box(battery, [0.1, 0.035, 0.012], [-0.29, 1.72, 0.44], "light", 0.008);
  const chargeSegments: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++)
    chargeSegments.push(
      box(
        battery,
        [0.07, 0.045, 0.018],
        [-0.08 + i * 0.12, 1.72, 0.44],
        "light",
        0.009,
      ),
    );
  for (const y of [0.62, 1.08])
    box(battery, [0.97, 0.013, 0.018], [0, y, 0.408], "face");
  for (const x of [-0.45, 0.45])
    box(battery, [0.12, 0.12, 0.42], [x, 0.17, 0], "trim");
  box(battery, [0.27, 0.04, 0.01], [0, 0.4, 0.415], "face");
  const batteryPort = port(battery, [0.23, 0.14, 0.13], [0, -1, 0]);

  const inverter = new THREE.Group();
  inverter.rotation.y = 0;
  models.inverter.add(inverter);
  box(inverter, [1.03, 1.62, 0.53], [0, 0.97, 0], "dark", 0.08);
  box(inverter, [0.94, 1.51, 0.14], [0, 0.98, 0.265], "shell", 0.06);
  box(inverter, [0.65, 0.57, 0.025], [0, 1.26, 0.35], "dark", 0.025);
  box(inverter, [0.44, 0.24, 0.016], [0, 1.35, 0.37], "screen", 0.012);
  for (let i = 0; i < 3; i++)
    box(
      inverter,
      [0.075, 0.022, 0.008],
      [-0.12 + i * 0.12, 1.35, 0.385],
      "light",
    );
  for (let i = 0; i < 4; i++)
    box(
      inverter,
      [0.06, 0.04, 0.02],
      [-0.18 + i * 0.12, 1.08, 0.375],
      "face",
      0.012,
    );
  for (let i = 0; i < 8; i++)
    box(inverter, [0.66, 0.019, 0.02], [0, 0.44 + i * 0.045, 0.347], "dark");
  for (const x of [-0.24, 0.24])
    box(inverter, [0.1, 0.12, 0.16], [x, 0.15, 0], "trim");
  const inverterSolarPort = port(inverter, [0.25, 1.78, 0.05], [0, 1, 0]);
  const inverterGridPort = port(inverter, [-0.25, 1.78, 0.05], [0, 1, 0]);
  const inverterBatteryPort = port(inverter, [-0.25, 0.16, 0.17], [0, -1, 0]);
  const inverterHomePort = port(inverter, [0.25, 0.16, 0.17], [0, -1, 0]);

  const home = models.home;
  // One house, with the battery and inverter installed on its front service wall.
  box(home, [4.6, 2.2, 3.2], [0, 1.22, 0], "wall", 0.035);
  box(home, [4.76, 0.16, 3.36], [0, 0.19, 0], "trim", 0.025);
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-2.3, 0);
  roofShape.lineTo(0, 1.55);
  roofShape.lineTo(2.3, 0);
  roofShape.closePath();
  const roofGeometry = new THREE.ExtrudeGeometry(roofShape, {
    depth: 3.2,
    bevelEnabled: false,
  });
  geometries.push(roofGeometry);
  const gable = new THREE.Mesh(roofGeometry, materials.wall);
  gable.position.set(0, 2.32, -1.6);
  home.add(gable);
  gable.castShadow = true;
  for (const side of [-1, 1]) {
    const roof = box(home, [2.92, 0.13, 3.66], [side * 1.15, 3.09, 0], "roof");
    roof.rotation.z = -side * 0.592;
    for (let i = 0; i < 13; i++) {
      const seam = box(
        home,
        [2.93, 0.025, 0.024],
        [side * 1.15, 3.17, -1.66 + i * 0.277],
        "trim",
      );
      seam.rotation.z = -side * 0.592;
    }
  }
  // A glazed entry and side windows leave the left front wall for the equipment.
  box(home, [0.83, 1.8, 0.08], [1.18, 1.08, 1.63], "dark", 0.025);
  box(home, [0.68, 1.48, 0.03], [1.18, 1.12, 1.69], "glass", 0.015);
  box(home, [0.045, 0.28, 0.055], [1.45, 1.04, 1.72], "shell");
  box(home, [0.94, 0.13, 0.55], [1.18, 0.18, 1.96], "trim", 0.02);
  box(home, [1.12, 0.07, 0.74], [1.18, 0.085, 2.03], "pad", 0.02);
  for (const z of [-0.75, 0.7]) {
    box(home, [0.065, 1.25, 1.03], [2.34, 1.37, z], "dark");
    box(home, [0.07, 1.11, 0.89], [2.38, 1.37, z], "glass");
    box(home, [0.08, 1.13, 0.035], [2.39, 1.37, z], "trim");
  }
  box(home, [0.58, 1.2, 0.52], [-1.4, 3.4, -0.9], "face", 0.02);
  box(home, [0.7, 0.12, 0.64], [-1.4, 4.0, -0.9], "dark", 0.015);
  // AC distribution point, connected to the inverter by a visible conduit.
  box(home, [0.33, 0.46, 0.13], [0.38, 1.37, 1.72], "dark", 0.02);
  box(home, [0.23, 0.3, 0.04], [0.38, 1.37, 1.8], "face", 0.01);
  for (let i = 0; i < 3; i++)
    box(home, [0.035, 0.075, 0.01], [0.31 + i * 0.07, 1.4, 1.825], "light");
  const homePort = port(home, [0.38, 1.14, 1.72], [0, -1, 0]);

  const grid = new THREE.Group();
  grid.rotation.y = 0.3;
  models.grid.add(grid);
  const levels = [0.17, 0.82, 1.42, 2.02, 2.54];
  const halfWidths = [0.51, 0.37, 0.27, 0.2, 0.08];
  for (let side = 0; side < 4; side++) {
    const face = new THREE.Group();
    face.rotation.y = (side * Math.PI) / 2;
    grid.add(face);
    for (const sign of [-1, 1])
      strut(face, [sign * 0.51, 0.17, 0.51], [sign * 0.08, 2.54, 0.08], 0.035);
    for (let i = 0; i < levels.length - 1; i++) {
      const w = halfWidths[i],
        n = halfWidths[i + 1],
        y = levels[i],
        ny = levels[i + 1];
      strut(face, [-w, y, w], [n, ny, n], 0.016);
      strut(face, [w, y, w], [-n, ny, n], 0.016);
      strut(face, [-w, y, w], [w, y, w], 0.025);
    }
  }
  for (const [y, width] of [
    [1.64, 1.9],
    [2.13, 1.55],
  ]) {
    box(grid, [width, 0.065, 0.12], [0, y, 0], "shell");
    for (const side of [-1, 1]) {
      strut(grid, [0, y + 0.3, 0], [(side * width) / 2, y, 0], 0.021);
      strut(
        grid,
        [side * width * 0.44, y, 0],
        [side * width * 0.44, y - 0.23, 0],
        0.047,
        "dark",
      );
      for (let j = 0; j < 4; j++)
        box(
          grid,
          [0.14, 0.024, 0.14],
          [side * width * 0.44, y - 0.07 - j * 0.046, 0],
          "face",
        );
    }
  }
  const gridPort = port(grid, [1.55 * 0.44, 1.9, 0], [0, -1, 0]);
  const site = new THREE.Group();
  box(site, [10.8, 0.16, 6.4], [-0.9, -0.08, 0.1], "pad", 0.18);
  box(site, [10.85, 0.04, 6.45], [-0.9, -0.16, 0.1], "dark", 0.12);
  // One continuous foundation ties the installation together.
  for (let i = 0; i < 2; i++)
    box(
      site,
      [1.05, 0.015, 0.44],
      [1.78, 0.015, 2.35 + i * 0.52],
      "trim",
      0.015,
    );
  models.home.position.set(0.6, 0, 0);
  models.solar.position.set(1.85, 3.19, 0);
  models.solar.rotation.z = -0.592;
  models.solar.scale.set(1.0, 1.0, 1.75);
  models.battery.position.set(-1.0, 0.28, 1.82);
  models.battery.scale.setScalar(0.72);
  models.inverter.position.set(0.08, 0.48, 1.8);
  models.inverter.scale.setScalar(0.82);
  models.grid.position.set(-4.6, 0, -0.75);
  models.grid.scale.setScalar(1.18);

  const point = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const solarStart = solarPort.point();
  const solarEnd = inverterSolarPort.point();
  const batteryStart = batteryPort.point();
  const batteryEnd = inverterBatteryPort.point();
  const homeStart = homePort.point();
  const homeEnd = inverterHomePort.point();
  const gridEnd = inverterGridPort.point();
  const cables = {
    solar: roundedCable([
      solarStart,
      solarPort.exit(),
      point(solarStart.x, solarStart.y, 2.08),
      point(solarStart.x, 2.93, 2.08),
      point(solarStart.x, 2.93, 1.72),
      point(solarStart.x, 2.26, 1.72),
      point(solarEnd.x, 2.26, 1.72),
      point(solarEnd.x, 2.26, solarEnd.z),
      inverterSolarPort.exit(),
      solarEnd,
    ]),
    battery: roundedCable([
      batteryStart,
      point(batteryStart.x, 0.12, batteryStart.z),
      point(batteryEnd.x, 0.12, batteryEnd.z),
      batteryEnd,
    ]),
    home: roundedCable([
      homeStart,
      point(homeStart.x, 0.36, homeStart.z),
      point(homeEnd.x, 0.36, homeEnd.z),
      homeEnd,
    ]),
    grid: new THREE.CurvePath<THREE.Vector3>(),
  };
  const gridWallEntry = point(-1.46, 2.07, 1.72);
  cables.grid.add(
    new THREE.CubicBezierCurve3(
      gridPort.point(),
      gridPort.exit().add(point(0, -0.4, 0)),
      gridWallEntry.clone().add(point(-0.7, 0, 0)),
      gridWallEntry,
    ),
  );
  cables.grid.add(
    roundedCable([
      gridWallEntry,
      point(gridEnd.x, 2.07, 1.72),
      point(gridEnd.x, 2.07, gridEnd.z),
      gridEnd,
    ]),
  );

  return {
    models,
    chargeSegments,
    site,
    cables,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    },
  };
}
