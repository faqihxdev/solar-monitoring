import { TelemetryStore } from "./store";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected a database path");

const store = await TelemetryStore.open(databasePath);
process.stdout.write("starting-transaction\n");
store.saveIfChanged("TEST-SN", {
  gts: "2026-09-03 12:01:00",
  readings: { battery_soc: 74 },
  readings_raw: { battery_soc: "74" },
  load_flows: {},
});
process.stdout.write("transaction-finished\n");
store.close();
