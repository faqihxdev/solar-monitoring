import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigResponse, Reading, ThresholdEntry } from "./api";
import {
  estimatePracticalEta,
  practicalBattery,
  practicalSocPct,
} from "./batteryModel";
import { POWMR_PROFILE, inverterProfile } from "./inverter";
import { sampleReading } from "../e2e/fixtures";

const base: ConfigResponse = {
  device_sn: "sandbox",
  db_path: "t.db",
  control_db_path: "c.db",
  server_now: 0,
};
const growattConfig: ConfigResponse = {
  ...base,
  inverter: {
    id: "growatt",
    name: "Growatt",
    writes: false,
    automation: false,
    battery_nominal_voltage: 51.2,
    soc_curve: [
      [40.0, 0],
      [51.2, 20],
      [52.16, 50],
      [53.6, 90],
      [58.4, 100],
    ],
  },
};
function threshold(id: string, value: number): ThresholdEntry {
  return {
    id,
    value,
    label: id,
    hint: "",
    color: "#000",
    field_id: id,
    scale: 1,
    from_device: true,
  };
}
const growattThresholds = [
  threshold("a6_return_pln", 54.0),
  threshold("a7_switch_pln", 51.2),
  threshold("a4_low_protection", 44.8),
];

test("profile falls back by what the server reports", () => {
  const unknown = inverterProfile(undefined);
  assert.equal(unknown.automation, false);
  assert.equal(practicalSocPct(53.6, unknown.socCurve), null);

  assert.equal(inverterProfile(base), POWMR_PROFILE);
  assert.equal(practicalSocPct(26.08, POWMR_PROFILE.socCurve), 50);
});

test("growatt profile uses the server curve and generic names", () => {
  const growatt = inverterProfile(growattConfig);
  assert.equal(growatt.writes, false);
  assert.equal(growatt.automation, false);
  assert.equal(practicalSocPct(52.16, growatt.socCurve), 50);
  assert.ok(Math.abs(practicalSocPct(52.88, growatt.socCurve)! - 70) < 1e-9);
  assert.equal(growatt.thresholdShort.a7_switch_pln, "GRID");

  const battery = practicalBattery(
    { battery_voltage: 51.0, battery_soc: 75, working_state: null },
    growattThresholds,
    growatt,
  );
  assert.equal(battery.stateLabel, "At grid switch point");
  assert.equal(battery.bufferLabel, "Grid buffer 0%");
  assert.equal(battery.practicalSocLabel, "Practical 20%");
});

test("powmr labels are unchanged", () => {
  const battery = practicalBattery(
    { battery_voltage: 25.0, battery_soc: 50, working_state: null },
    [threshold("a6_return_pln", 27.0), threshold("a7_switch_pln", 25.2)],
    POWMR_PROFILE,
  );
  assert.equal(battery.stateLabel, "At A7 mains point");
  assert.equal(battery.bufferLabel, "A7 buffer 0%");
});

test("discharge ETA names the growatt grid switch point", () => {
  const growatt = inverterProfile(growattConfig);
  const start = 1_800_000_000;
  // Falls from 70% to 50% over two hours while the battery carries the load.
  const history: Reading[] = Array.from({ length: 9 }, (_, i) =>
    sampleReading({
      polled_at: start + i * 900,
      battery_voltage: 52.88 - (0.72 * i) / 8,
      battery_status: 1,
      working_state: "Battery Discharging",
    }),
  );
  const eta = estimatePracticalEta(
    history,
    history[history.length - 1],
    growattThresholds,
    growatt,
  );
  assert.ok(eta, "expected an ETA");
  assert.equal(eta.targetId, "grid switch");
  assert.match(eta.label, /to grid switch \(20%\)$/);
});
