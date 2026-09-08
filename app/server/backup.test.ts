import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseBackupArgs,
  resolveSourcePaths,
  runBackup,
  timestampId,
} from "./backup";
import { TelemetryStore } from "./store";

const NOW = new Date("2026-09-03T12:34:56.789Z");
const STAMP = "20260903T123456789Z";

async function createDatabase(filePath: string, deviceSn: string): Promise<void> {
  const store = await TelemetryStore.open(filePath);
  store.saveIfChanged(deviceSn, {
    gts: NOW.toISOString(),
    readings: { battery_soc: 75 },
    readings_raw: { battery_soc: "75" },
    load_flows: {},
  });
  store.close();
}

async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-backup-"));
  const telemetryDbPath = path.join(directory, "data", "solar.db");
  const controlDbPath = path.join(directory, "data", "solar-control.db");
  const destination = path.join(directory, "backups");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await createDatabase(telemetryDbPath, "TELEMETRY-SN");
  await createDatabase(controlDbPath, "CONTROL-SN");
  return { directory, telemetryDbPath, controlDbPath, destination };
}

test("creates a private, verified database pair and manifest", async (t) => {
  const paths = await fixture(t);

  const result = await runBackup({
    ...paths,
    keep: 14,
    now: NOW,
  });

  assert.equal(result.id, STAMP);
  assert.deepEqual(fs.readdirSync(paths.destination).sort(), [
    `manifest-${STAMP}.json`,
    `solar-${STAMP}.db`,
    `solar-control-${STAMP}.db`,
  ]);

  const telemetry = await TelemetryStore.open(result.telemetryPath, { readOnly: true });
  const control = await TelemetryStore.open(result.controlPath, { readOnly: true });
  try {
    assert.equal(telemetry.quickCheck(), true);
    assert.equal(control.quickCheck(), true);
    assert.equal(telemetry.snapshotCount("TELEMETRY-SN"), 1);
    assert.equal(control.snapshotCount("CONTROL-SN"), 1);
  } finally {
    telemetry.close();
    control.close();
  }

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8")) as {
    version: number;
    backup_id: string;
    created_at: string;
    files: Array<{
      role: string;
      filename: string;
      bytes: number;
      sha256: string;
      quick_check: string;
    }>;
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.backup_id, STAMP);
  assert.equal(manifest.created_at, NOW.toISOString());
  assert.deepEqual(manifest.files.map((file) => file.role), ["telemetry", "control"]);
  for (const file of manifest.files) {
    assert.ok(file.bytes > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(file.quick_check, "ok");
    assert.equal(fs.statSync(path.join(paths.destination, file.filename)).size, file.bytes);
  }

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(paths.destination).mode & 0o777, 0o700);
    for (const filePath of [result.telemetryPath, result.controlPath, result.manifestPath]) {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    }
  }
});

test("failure removes only files created for the attempted set", async (t) => {
  const paths = await fixture(t);
  fs.mkdirSync(paths.destination, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.destination, 0o700);
  const preexistingControl = path.join(paths.destination, `solar-control-${STAMP}.db`);
  fs.writeFileSync(preexistingControl, "preexisting-do-not-delete");

  await assert.rejects(
    runBackup({ ...paths, keep: 14, now: NOW }),
    /already exists/i,
  );

  assert.equal(fs.existsSync(path.join(paths.destination, `solar-${STAMP}.db`)), false);
  assert.equal(fs.existsSync(path.join(paths.destination, `manifest-${STAMP}.json`)), false);
  assert.equal(fs.readFileSync(preexistingControl, "utf8"), "preexisting-do-not-delete");
});

test("retention prunes only older complete strict-name sets", async (t) => {
  const paths = await fixture(t);
  fs.mkdirSync(paths.destination, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.destination, 0o700);
  const oldIds = [
    "20260901T010101001Z",
    "20260901T020202002Z",
    "20260901T030303003Z",
  ];
  for (const id of oldIds) {
    fs.writeFileSync(path.join(paths.destination, `solar-${id}.db`), id);
    fs.writeFileSync(path.join(paths.destination, `solar-control-${id}.db`), id);
    fs.writeFileSync(path.join(paths.destination, `manifest-${id}.json`), id);
  }
  const incomplete = "20260801T010101001Z";
  fs.writeFileSync(path.join(paths.destination, `solar-${incomplete}.db`), "keep incomplete");
  fs.writeFileSync(path.join(paths.destination, "solar-not-a-timestamp.db"), "foreign");
  fs.writeFileSync(path.join(paths.destination, "notes.txt"), "foreign");
  const retentionDeletes: string[] = [];
  const originalUnlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (filePath: Parameters<typeof fs.unlinkSync>[0]) => {
    const filename = path.basename(String(filePath));
    if (oldIds.some((id) => filename.includes(id))) retentionDeletes.push(filename);
    return originalUnlink(filePath);
  });

  const result = await runBackup({ ...paths, keep: 2, now: NOW });

  assert.deepEqual(result.prunedIds, oldIds.slice(0, 2));
  for (const id of oldIds.slice(0, 2)) {
    const deletesForId = retentionDeletes.filter((filename) => filename.includes(id));
    assert.equal(deletesForId[0], `manifest-${id}.json`);
    assert.deepEqual(new Set(deletesForId.slice(1)), new Set([
      `solar-${id}.db`,
      `solar-control-${id}.db`,
    ]));
    assert.equal(fs.existsSync(path.join(paths.destination, `solar-${id}.db`)), false);
    assert.equal(fs.existsSync(path.join(paths.destination, `solar-control-${id}.db`)), false);
    assert.equal(fs.existsSync(path.join(paths.destination, `manifest-${id}.json`)), false);
  }
  for (const filename of [
    `solar-${oldIds[2]}.db`,
    `solar-control-${oldIds[2]}.db`,
    `manifest-${oldIds[2]}.json`,
    `solar-${incomplete}.db`,
    "solar-not-a-timestamp.db",
    "notes.txt",
  ]) {
    assert.equal(fs.existsSync(path.join(paths.destination, filename)), true, filename);
  }
});

test("arguments require an absolute destination and positive integer retention", () => {
  assert.throws(() => parseBackupArgs([]), /--destination/);
  assert.throws(
    () => parseBackupArgs(["--destination", "relative", "--keep", "14"]),
    /absolute/i,
  );
  assert.throws(
    () => parseBackupArgs(["--destination", path.resolve("backups"), "--keep", "0"]),
    /positive integer/i,
  );
  assert.throws(
    () => parseBackupArgs(["--destination", path.resolve("backups"), "--keep", "1.5"]),
    /positive integer/i,
  );
  assert.throws(
    () => parseBackupArgs(["--destination", path.resolve("backups"), "--keep", "14", "--oops"]),
    /unknown argument/i,
  );
  assert.deepEqual(
    parseBackupArgs(["--destination", path.resolve("backups"), "--keep", "14"]),
    { destination: path.resolve("backups"), keep: 14 },
  );
  assert.deepEqual(
    parseBackupArgs(["--", "--destination", path.resolve("backups"), "--keep", "14"]),
    { destination: path.resolve("backups"), keep: 14 },
  );
});

test("source paths default to repo data and honor relative or absolute overrides", () => {
  const root = path.resolve("synthetic-repo");
  assert.deepEqual(resolveSourcePaths(root, {}), {
    telemetryDbPath: path.join(root, "data", "solar.db"),
    controlDbPath: path.join(root, "data", "solar-control.db"),
  });
  assert.deepEqual(
    resolveSourcePaths(root, {
      DESS_DB_PATH: "state/main.db",
      DESS_CONTROL_DB_PATH: path.resolve("outside", "control.db"),
    }),
    {
      telemetryDbPath: path.join(root, "state", "main.db"),
      controlDbPath: path.resolve("outside", "control.db"),
    },
  );
  assert.equal(timestampId(NOW), STAMP);
});
