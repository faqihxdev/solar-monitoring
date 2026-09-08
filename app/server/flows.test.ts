import assert from "node:assert/strict";
import test from "node:test";
import { effectiveGridPower, inferEnergyFlows } from "./flows";
import { estimateBatteryPower } from "../shared/energyFlows";

const near = (actual: unknown, expected: number) =>
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-8,
    `${actual} != ${expected}`,
  );

test("source allocations and battery estimates conserve power across import/export cases", () => {
  for (const pv of [0, 0.003, 0.606, 1.2])
    for (const load of [0, 0.003, 0.609, 1.2])
      for (const grid of [-0.4, 0, 0.4]) {
        const net = pv + grid - load;
        const status = Math.abs(net) < 1e-9 ? 0 : net > 0 ? -1 : 1;
        const reading = {
          pv_power: pv * 1000,
          load_power: load,
          grid_power: grid,
          battery_power: 0,
          battery_status: status,
          working_state: "Battery state",
        };
        const f = inferEnergyFlows(reading);
        near(
          Number(f.pv_to_load_kw) +
            Number(f.grid_to_load_kw) +
            Number(f.battery_to_load_kw),
          load,
        );
        near(
          Number(f.pv_to_load_kw) +
            Number(f.pv_to_battery_kw) +
            Number(f.pv_to_grid_kw),
          pv,
        );
        near(
          Number(f.grid_to_load_kw) + Number(f.grid_to_battery_kw),
          Math.max(0, grid),
        );
        near(
          Number(f.pv_to_grid_kw) + Number(f.battery_to_grid_kw),
          Math.max(0, -grid),
        );
        near(estimateBatteryPower(reading), Math.abs(net));
        near(
          status === -1
            ? Number(f.pv_to_battery_kw) + Number(f.grid_to_battery_kw)
            : Number(f.battery_to_load_kw) + Number(f.battery_to_grid_kw),
          Math.abs(net),
        );
      }
});

test("mains source allocation uses the measured battery balance", () => {
  const reading = {
    working_state: "Mains state",
    pv_power: 100,
    load_power: 0.5,
    grid_power: 0,
    battery_power: 0.3,
    battery_status: -1,
  };
  near(effectiveGridPower(reading).grid_power_kw, 0.7);
  const flows = inferEnergyFlows(reading);
  near(flows.grid_to_load_kw, 0.5);
  near(flows.grid_to_battery_kw, 0.2);
  near(flows.pv_to_battery_kw, 0.1);
});

test("small mains solar charging is not mistaken for unknown grid charging", () => {
  const flows = inferEnergyFlows({
    working_state: "Mains state",
    pv_power: 3,
    load_power: 0.5,
    grid_power: 0,
    battery_power: 0,
    battery_status: -1,
  });
  near(flows.pv_to_battery_kw, 0.003);
  assert.equal(flows.grid_to_battery_unmetered, false);
});

test("solar surplus alone does not invent a grid export", () => {
  const reading = {
    working_state: "Battery state",
    pv_power: 1200,
    load_power: 0.5,
    grid_power: 0,
    battery_power: 0,
    battery_status: 0,
  };
  assert.equal(effectiveGridPower(reading).grid_power_kw, 0);
  assert.equal(inferEnergyFlows(reading).pv_to_grid_kw, 0);
});

test("off-grid mode is not classified as mains-connected", () => {
  const reading = {
    working_state: "Off-grid",
    grid_power: null,
    pv_power: 606,
    load_power: 0.609,
    battery_power: 0,
    battery_status: 1,
  };
  near(estimateBatteryPower(reading), 0.003);
  assert.equal(inferEnergyFlows(reading).on_mains, false);
});
