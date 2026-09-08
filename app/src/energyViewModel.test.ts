import assert from "node:assert/strict";
import test from "node:test";
import { energyConnections } from "./energyViewModel";
import { sampleReading } from "../e2e/fixtures";
import { effectiveGridPower, inferEnergyFlows } from "../server/flows";

function connections(overrides: Parameters<typeof sampleReading>[0]) {
  const raw = sampleReading({ battery_power: 0, ...overrides });
  const grid = effectiveGridPower(raw);
  return energyConnections({
    ...raw,
    ...inferEnergyFlows(raw),
    grid_power_effective: grid.grid_power_kw,
    grid_power_inferred: grid.grid_power_inferred,
  });
}
const cases = [
  {
    name: "609 W load minus 606 W solar",
    input: { battery_status: 1, pv_power: 606, load_power: 0.609 },
    detail: "≈ 3 W out",
  },
  {
    name: "small solar surplus",
    input: { pv_power: 609, load_power: 0.606 },
    detail: "≈ 3 W in",
  },
  {
    name: "less than one watt",
    input: { pv_power: 606.2, load_power: 0.606 },
    detail: "<1 W in",
  },
  {
    name: "balanced rounded readings",
    input: { battery_status: 1, pv_power: 606, load_power: 0.606 },
    detail: "≈ 0 W out",
  },
  {
    name: "solar charging while PLN supplies home",
    input: {
      pv_power: 234.26,
      load_power: 0.241,
      working_state: "Mains state",
    },
    detail: "≈ 234 W in",
  },
  {
    name: "solar surplus",
    input: { pv_power: 1800, load_power: 1 },
    detail: "≈ 800 W in",
  },
  {
    name: "combined solar and grid charging",
    input: {
      pv_power: 600,
      load_power: 1,
      grid_power: 1.4,
      working_state: "Mains state",
    },
    detail: "≈ 1,000 W in",
  },
  {
    name: "solar charging while exporting",
    input: { pv_power: 2000, load_power: 1, grid_power: -0.3 },
    detail: "≈ 700 W in",
  },
  {
    name: "battery supplying home and export",
    input: {
      battery_status: 1,
      pv_power: 600,
      load_power: 1,
      grid_power: -0.2,
    },
    detail: "≈ 600 W out",
  },
  {
    name: "solar and battery sharing export",
    input: {
      battery_status: 1,
      pv_power: 1200,
      load_power: 1,
      grid_power: -0.3,
    },
    detail: "≈ 100 W out",
  },
  {
    name: "missing grid reading in battery mode",
    input: {
      battery_status: 1,
      pv_power: 600,
      load_power: 1,
      grid_power: null,
    },
    detail: "≈ 400 W out",
  },
  {
    name: "missing grid reading with confirmed grid outage",
    input: {
      battery_status: 1,
      pv_power: 600,
      load_power: 1,
      grid_power: null,
      working_state: null,
      grid_voltage: 0,
    },
    detail: "≈ 400 W out",
  },
  {
    name: "unknown load cancels in mains solar charging",
    input: { pv_power: 600, load_power: null, working_state: "Mains state" },
    detail: "≈ 600 W in",
  },
  {
    name: "grid charging at night",
    input: {
      pv_power: 0,
      load_power: 0.5,
      grid_power: 0.7,
      working_state: "Mains state",
    },
    detail: "≈ 200 W in",
  },
  {
    name: "reported idle with no battery meter",
    input: { battery_status: 0, battery_power: null },
    detail: "≈ 0 W idle",
  },
];
for (const { name, input, detail } of cases) {
  test(`battery estimate: ${name}`, () => {
    const battery = connections(input).find((c) => c.id === "battery")!;
    assert.equal(battery.flowDetail, detail);
    assert.equal(battery.inferred, true);
    assert.equal(battery.unmetered, false);
  });
}

test("reported battery power takes priority, including less than 10 W", () => {
  for (const [power, detail] of [
    [0.003, "3 W out"],
    [0.0002, "<1 W out"],
    [1.42, "1,420 W out"],
  ] as const) {
    const battery = connections({
      battery_power: power,
      battery_status: 1,
    }).find((c) => c.id === "battery")!;
    assert.equal(battery.flowDetail, detail);
    assert.equal(battery.inferred, false);
  }
});

test("missing inputs and contradictory directions do not produce invented battery totals", () => {
  for (const input of [
    { pv_power: null },
    { pv_power: NaN },
    { load_power: null },
    { grid_power: null, working_state: null },
    { pv_power: 600, load_power: 1 },
    { battery_status: 1, pv_power: 1400, load_power: 1 },
    { pv_power: 0, working_state: "Mains state" },
  ]) {
    const battery = connections(input).find((c) => c.id === "battery")!;
    assert.equal(battery.value, "Unmetered", JSON.stringify(input));
    assert.equal(battery.inferred, false);
  }
});

test("unknown telemetry stays inactive and older readings retain their flow", () => {
  assert.ok(energyConnections(null).every((c) => c.value === "—" && !c.active));
  const stale = connections({
    battery_status: 1,
    pv_power: 606,
    load_power: 0.609,
    polled_at: Date.now() / 1000 - 3600,
  });
  assert.deepEqual(
    stale.filter((c) => c.active).map((c) => c.id),
    ["solar", "battery", "home"],
  );
  assert.equal(stale.find((c) => c.id === "battery")!.flowDetail, "≈ 3 W out");
});

test("grid power can be inferred from measured battery charging and discharging", () => {
  for (const [status, power, expected] of [
    [-1, 0.3, "≈ 700 W"],
    [1, 0.2, "≈ 200 W"],
  ] as const) {
    const grid = connections({
      working_state: "Mains state",
      pv_power: 100,
      load_power: 0.5,
      battery_power: power,
      battery_status: status,
    }).find((c) => c.id === "grid")!;
    assert.equal(grid.value, expected);
    assert.equal(grid.inferred, true);
  }
});

test("a small reported grid flow remains measured", () => {
  const grid = connections({
    grid_power: 0.003,
    working_state: "Mains state",
    pv_power: 0,
    load_power: 0.001,
  }).find((c) => c.id === "grid")!;
  assert.equal(grid.value, "3 W");
  assert.equal(grid.inferred, false);
  assert.equal(grid.active, true);
});

test("unknown grid charging exposes a minimum instead of hiding the known home load", () => {
  const result = connections({
    pv_power: 0,
    load_power: 1.2,
    working_state: "Mains state",
  });
  const grid = result.find((c) => c.id === "grid")!;
  assert.equal(grid.value, "≥ 1.20 kW");
  assert.equal(grid.minimum, true);
  assert.equal(result.find((c) => c.id === "battery")!.value, "Unmetered");
});

test("unknown solar or battery discharge cannot establish a minimum grid total", () => {
  for (const input of [
    { pv_power: null },
    { battery_status: 1, pv_power: 100 },
  ]) {
    const grid = connections({ working_state: "Mains state", ...input }).find(
      (c) => c.id === "grid",
    )!;
    assert.equal(grid.value, "Unmetered");
    assert.equal(grid.minimum, false);
  }
});

test("minimum grid readings remain numeric below one watt and never round up", () => {
  for (const [load, expected] of [
    [0.0004, "≥ 0.4 W"],
    [0.5009, "≥ 500 W"],
    [1.239, "≥ 1.23 kW"],
  ] as const) {
    const grid = connections({
      pv_power: 0,
      load_power: load,
      working_state: "Mains state",
    }).find((c) => c.id === "grid")!;
    assert.equal(grid.value, expected);
  }
});
