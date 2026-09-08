import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import SqliteDatabase from "better-sqlite3";

import { TelemetryStore } from "./store";

function databaseDigest(filePath: string): string {
  const hash = createHash("sha256");
  for (const suffix of ["", "-wal"]) {
    const candidate = `${filePath}${suffix}`;
    if (fs.existsSync(candidate)) hash.update(suffix).update(fs.readFileSync(candidate));
  }
  return hash.digest("hex");
}

test("unchanged telemetry does not rewrite the database", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));

  const databasePath = path.join(directory, "solar.db");
  const store = await TelemetryStore.open(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const payload = {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75, pv_power: 1200 },
    readings_raw: { battery_soc: "75", pv_power: "1200" },
    load_flows: { pv_to_load_kw: 1.2 },
  };

  assert.equal(store.saveIfChanged("TEST-SN", payload), true);
  const digestAfterChange = databaseDigest(databasePath);

  await delay(10);
  assert.equal(store.saveIfChanged("TEST-SN", payload), false);

  assert.equal(databaseDigest(databasePath), digestAfterChange);
});

test("opening an initialized writable store does not rewrite it", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  let store = await TelemetryStore.open(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.saveIfChanged("TEST-SN", {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });
  store.close();
  const before = databaseDigest(databasePath);

  store = await TelemetryStore.open(databasePath);
  store.close();

  assert.equal(databaseDigest(databasePath), before);
});

test("steady telemetry records a rate-limited successful-poll heartbeat", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const store = await TelemetryStore.open(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let nowMs = 1_800_000_000_000;
  t.mock.method(Date, "now", () => nowMs);
  const payload = {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  };

  assert.equal(store.saveIfChanged("TEST-SN", payload), true);
  assert.equal(store.summary("TEST-SN").last_polled_at, nowMs / 1000);

  nowMs += 59_000;
  assert.equal(store.saveIfChanged("TEST-SN", payload), false);
  assert.equal(store.summary("TEST-SN").last_polled_at, (nowMs - 59_000) / 1000);

  nowMs += 2_000;
  assert.equal(store.saveIfChanged("TEST-SN", payload), false);
  assert.equal(store.summary("TEST-SN").last_polled_at, nowMs / 1000);
});

test("new snapshots persist only raw readings instead of the full telemetry payload", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const store = await TelemetryStore.open(databasePath);
  let reader: TelemetryStore | null = null;
  t.after(() => {
    reader?.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(
    store.saveIfChanged("TEST-SN", {
      gts: "2026-09-03 12:00:00",
      readings: { battery_soc: 75 },
      readings_raw: { battery_soc: "75" },
      load_flows: {},
      last_data: { unused_blob: "x".repeat(1_000_000) },
    }),
    true,
  );
  store.close();

  assert.ok(fs.statSync(databasePath).size < 512_000);
  reader = await TelemetryStore.open(databasePath, { readOnly: true });
  assert.deepEqual(reader.latestReadingsRaw("TEST-SN"), { battery_soc: "75" });
});

test("a read-only connection sees newly committed writer updates without reopening", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const writer = await TelemetryStore.open(databasePath);
  const reader = await TelemetryStore.open(databasePath, { readOnly: true });
  t.after(() => {
    reader.close();
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(reader.snapshotCount("TEST-SN"), 0);
  assert.equal(
    writer.saveIfChanged("TEST-SN", {
      gts: "2026-09-03 12:00:00",
      readings: { battery_soc: 75 },
      readings_raw: { battery_soc: "75" },
      load_flows: {},
    }),
    true,
  );

  assert.equal(reader.snapshotCount("TEST-SN"), 1);
  assert.deepEqual(reader.latestReadingsRaw("TEST-SN"), { battery_soc: "75" });
});

test("legacy full telemetry payloads remain readable", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const writer = await TelemetryStore.open(databasePath);
  let reader: TelemetryStore | null = null;
  t.after(() => {
    reader?.close();
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  writer.saveIfChanged("TEST-SN", {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });
  writer.close();

  const fixture = new SqliteDatabase(databasePath);
  fixture
    .prepare("UPDATE telemetry_snapshots SET payload_json = ?")
    .run(
      JSON.stringify({
        readings_raw: { battery_soc: "75" },
        last_data: { legacy: true },
        energy_flow: { legacy: true },
      }),
    );
  fixture.close();

  reader = await TelemetryStore.open(databasePath, { readOnly: true });
  assert.deepEqual(reader.latestReadingsRaw("TEST-SN"), { battery_soc: "75" });
  assert.deepEqual(reader.recentSnapshots("TEST-SN", 1)[0]?.readings_raw, {
    battery_soc: "75",
  });
});

test("explicit payload compaction preserves readings and database integrity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  let store = await TelemetryStore.open(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  store.saveIfChanged("TEST-SN", {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });
  store.close();

  const fixture = new SqliteDatabase(databasePath);
  fixture
    .prepare("UPDATE telemetry_snapshots SET payload_json = ?")
    .run(
      JSON.stringify({
        readings_raw: { battery_soc: "75" },
        last_data: { unused_blob: "x".repeat(2_000_000) },
      }),
    );
  fixture.close();
  const sizeBefore = fs.statSync(databasePath).size;

  store = await TelemetryStore.open(databasePath);
  const countBefore = store.snapshotCount("TEST-SN");
  assert.equal(store.compactTelemetryPayloads({ vacuum: true }), 1);

  assert.equal(store.snapshotCount("TEST-SN"), countBefore);
  assert.deepEqual(store.latestReadingsRaw("TEST-SN"), { battery_soc: "75" });
  assert.equal(store.quickCheck(), true);
  store.close();
  assert.ok(fs.statSync(databasePath).size < sizeBefore / 2);
});

test("online backup publishes a verified database without overwriting an existing backup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const backupPath = path.join(directory, "backups", "solar.db");
  const store = await TelemetryStore.open(databasePath);
  let backup: TelemetryStore | null = null;
  t.after(() => {
    backup?.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  store.saveIfChanged("TEST-SN", {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });

  await store.backup(backupPath);

  backup = await TelemetryStore.open(backupPath, { readOnly: true });
  assert.equal(backup.quickCheck(), true);
  assert.equal(backup.snapshotCount("TEST-SN"), 1);
  assert.deepEqual(backup.latestReadingsRaw("TEST-SN"), { battery_soc: "75" });
  await assert.rejects(store.backup(backupPath), /already exists/i);
  assert.equal(
    fs.readdirSync(path.dirname(backupPath)).some((name) => name.includes(".partial-")),
    false,
  );
});

test("a process kill during a transaction preserves the committed database", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  let store = await TelemetryStore.open(databasePath);
  let child: ReturnType<typeof spawn> | null = null;
  t.after(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  store.saveIfChanged("TEST-SN", {
    gts: "2026-09-03 12:00:00",
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });
  store.close();

  const fixture = new SqliteDatabase(databasePath);
  fixture.exec(`
    CREATE TABLE crash_padding (payload BLOB NOT NULL);
    CREATE TRIGGER slow_snapshot_write
    AFTER INSERT ON telemetry_snapshots
    BEGIN
      INSERT INTO crash_padding (payload) VALUES (randomblob(268435456));
    END;
  `);
  fixture.close();

  const crashWriterPath = fileURLToPath(new URL("./store-crash-writer.fixture.ts", import.meta.url));
  child = spawn(process.execPath, ["--import", "tsx", crashWriterPath, databasePath], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Crash writer did not start: ${stderr}`)), 10_000);
    child?.once("error", reject);
    child?.once("exit", (code) => {
      if (!stdout.includes("starting-transaction")) {
        reject(new Error(`Crash writer exited early (${code}): ${stderr}`));
      }
    });
    child?.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("starting-transaction")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await delay(20);
  assert.equal(stdout.includes("transaction-finished"), false, "fault injection missed the transaction");
  assert.equal(child.kill("SIGKILL"), true);
  await once(child, "exit");

  store = await TelemetryStore.open(databasePath);
  assert.equal(store.quickCheck(), true);
  assert.equal(store.snapshotCount("TEST-SN"), 1);
});

test("voltage detail pages are committed as one store batch", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-store-"));
  const databasePath = path.join(directory, "solar.db");
  const store = await TelemetryStore.open(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const title = [
    { title: "Timestamp" },
    { title: "Battery Voltage" },
    { title: "MPPT Battery Voltage" },
  ];
  const count = store.syncDetailsVoltagePages("TEST-SN", [
    { title, row: [{ field: ["2026-09-03 12:00:00", "51.2", "52.1"] }] },
    { title, row: [{ field: ["2026-09-03 12:01:00", "51.3", "52.2"] }] },
  ]);

  assert.equal(count, 2);
  assert.equal(store.latestVoltage("TEST-SN")?.battery_voltage, 51.3);
});
