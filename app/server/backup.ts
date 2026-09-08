import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { TelemetryStore } from "./store";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TIMESTAMP_PATTERN =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

interface BackupArguments {
  destination: string;
  keep: number;
}

interface SourcePaths {
  telemetryDbPath: string;
  controlDbPath: string;
}

export interface RunBackupOptions extends SourcePaths {
  destination: string;
  keep: number;
  now?: Date;
}

export interface BackupResult {
  id: string;
  telemetryPath: string;
  controlPath: string;
  manifestPath: string;
  prunedIds: string[];
}

interface ManifestFile {
  role: "telemetry" | "control";
  filename: string;
  bytes: number;
  sha256: string;
  quick_check: "ok";
}

export function parseBackupArgs(args: string[]): BackupArguments {
  let destination: string | undefined;
  let keepRaw: string | undefined;
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const argument = normalizedArgs[index];
    if (argument !== "--destination" && argument !== "--keep") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    index += 1;

    if (argument === "--destination") {
      if (destination != null) throw new Error("Duplicate argument: --destination");
      destination = value;
    } else {
      if (keepRaw != null) throw new Error("Duplicate argument: --keep");
      keepRaw = value;
    }
  }

  if (!destination) throw new Error("Missing required argument: --destination");
  if (!path.isAbsolute(destination)) throw new Error("--destination must be an absolute directory");
  if (keepRaw == null) throw new Error("Missing required argument: --keep");
  if (!/^[1-9]\d*$/.test(keepRaw)) throw new Error("--keep must be a positive integer");
  const keep = Number(keepRaw);
  if (!Number.isSafeInteger(keep)) throw new Error("--keep must be a positive integer");

  return { destination: path.resolve(destination), keep };
}

export function resolveSourcePaths(
  projectRoot: string,
  environment: Record<string, string | undefined>,
): SourcePaths {
  return {
    telemetryDbPath: path.resolve(projectRoot, environment.DESS_DB_PATH ?? "data/solar.db"),
    controlDbPath: path.resolve(
      projectRoot,
      environment.DESS_CONTROL_DB_PATH ?? "data/solar-control.db",
    ),
  };
}

export function timestampId(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Backup timestamp must be a valid date");
  return date.toISOString().replace(/[-:.]/g, "");
}

function isValidTimestampId(id: string): boolean {
  const match = id.match(TIMESTAMP_PATTERN);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`,
  );
  return Number.isFinite(parsed.getTime()) && timestampId(parsed) === id;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function prepareDestination(destination: string, sources: SourcePaths): void {
  if (!path.isAbsolute(destination)) throw new Error("Backup destination must be absolute");
  if (samePath(destination, path.parse(destination).root)) {
    throw new Error("Backup destination cannot be a filesystem root");
  }
  if (samePath(sources.telemetryDbPath, sources.controlDbPath)) {
    throw new Error("Telemetry and control database sources must differ");
  }
  for (const source of [sources.telemetryDbPath, sources.controlDbPath]) {
    if (samePath(destination, path.dirname(source))) {
      throw new Error("Backup destination must differ from the live database directory");
    }
  }

  if (fs.existsSync(destination)) {
    const destinationStat = fs.lstatSync(destination);
    if (destinationStat.isSymbolicLink()) throw new Error("Backup destination cannot be a symlink");
    if (!destinationStat.isDirectory()) throw new Error("Backup destination must be a directory");
    if (process.platform !== "win32" && (destinationStat.mode & 0o077) !== 0) {
      throw new Error("Existing backup destination must have private 0700 permissions");
    }
  } else {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    fs.chmodSync(destination, 0o700);
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function verifyBackup(databasePath: string): Promise<void> {
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
  const preexistingSidecars = new Set(sidecars.filter((sidecar) => fs.existsSync(sidecar)));
  let verifier: TelemetryStore | null = null;
  try {
    verifier = await TelemetryStore.open(databasePath, { readOnly: true });
    if (!verifier.quickCheck()) throw new Error(`Backup failed quick_check: ${path.basename(databasePath)}`);
  } finally {
    verifier?.close();
    for (const sidecar of sidecars) {
      if (!preexistingSidecars.has(sidecar)) unlinkIfPresent(sidecar);
    }
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeManifestAtomically(manifestPath: string, manifest: unknown): void {
  const directory = path.dirname(manifestPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(manifestPath)}.partial-${process.pid}-${randomUUID()}`,
  );
  let published = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(temporaryPath, 0o600);
    const descriptor = fs.openSync(temporaryPath, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.linkSync(temporaryPath, manifestPath);
    published = true;
    fs.unlinkSync(temporaryPath);
    syncDirectory(directory);
  } catch (error) {
    if (published) unlinkIfPresent(manifestPath);
    unlinkIfPresent(temporaryPath);
    throw error;
  }
}

function backupSetNames(id: string): [string, string, string] {
  return [`solar-${id}.db`, `solar-control-${id}.db`, `manifest-${id}.json`];
}

function completeBackupIds(destination: string): string[] {
  const sets = new Map<string, Set<string>>();
  const patterns: Array<[RegExp, "telemetry" | "control" | "manifest"]> = [
    [/^solar-(\d{8}T\d{9}Z)\.db$/, "telemetry"],
    [/^solar-control-(\d{8}T\d{9}Z)\.db$/, "control"],
    [/^manifest-(\d{8}T\d{9}Z)\.json$/, "manifest"],
  ];

  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    for (const [pattern, role] of patterns) {
      const match = entry.name.match(pattern);
      const id = match?.[1];
      if (!id || !isValidTimestampId(id)) continue;
      const roles = sets.get(id) ?? new Set<string>();
      roles.add(role);
      sets.set(id, roles);
      break;
    }
  }

  return [...sets.entries()]
    .filter(([, roles]) => roles.size === 3)
    .map(([id]) => id)
    .sort((left, right) => right.localeCompare(left));
}

function pruneOlderBackupSets(destination: string, keep: number, currentId: string): string[] {
  const olderIds = completeBackupIds(destination).filter((id) => id < currentId);
  const pruneIds = olderIds.slice(Math.max(0, keep - 1));
  for (const id of pruneIds) {
    const [telemetryName, controlName, manifestName] = backupSetNames(id);
    // The manifest is the completion marker. Remove it before either database
    // so an interrupted prune cannot advertise an incomplete backup set.
    for (const filename of [manifestName, telemetryName, controlName]) {
      unlinkIfPresent(path.join(destination, filename));
    }
  }
  if (pruneIds.length) syncDirectory(destination);
  return pruneIds.sort();
}

async function manifestFile(
  role: ManifestFile["role"],
  filePath: string,
): Promise<ManifestFile> {
  return {
    role,
    filename: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: await fileSha256(filePath),
    quick_check: "ok",
  };
}

export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  if (!Number.isSafeInteger(options.keep) || options.keep < 1) {
    throw new Error("Backup retention must be a positive integer");
  }
  const destination = path.resolve(options.destination);
  const sources = {
    telemetryDbPath: path.resolve(options.telemetryDbPath),
    controlDbPath: path.resolve(options.controlDbPath),
  };
  prepareDestination(destination, sources);

  const now = options.now ?? new Date();
  const id = timestampId(now);
  const [telemetryName, controlName, manifestName] = backupSetNames(id);
  const telemetryPath = path.join(destination, telemetryName);
  const controlPath = path.join(destination, controlName);
  const manifestPath = path.join(destination, manifestName);
  const createdPaths: string[] = [];
  let telemetryStore: TelemetryStore | null = null;
  let controlStore: TelemetryStore | null = null;

  try {
    telemetryStore = await TelemetryStore.open(sources.telemetryDbPath, { readOnly: true });
    controlStore = await TelemetryStore.open(sources.controlDbPath, { readOnly: true });
    if (!telemetryStore.quickCheck()) throw new Error("Telemetry source database failed quick_check");
    if (!controlStore.quickCheck()) throw new Error("Control source database failed quick_check");

    await telemetryStore.backup(telemetryPath);
    createdPaths.push(telemetryPath);
    fs.chmodSync(telemetryPath, 0o600);
    await verifyBackup(telemetryPath);

    await controlStore.backup(controlPath);
    createdPaths.push(controlPath);
    fs.chmodSync(controlPath, 0o600);
    await verifyBackup(controlPath);

    const files = await Promise.all([
      manifestFile("telemetry", telemetryPath),
      manifestFile("control", controlPath),
    ]);
    writeManifestAtomically(manifestPath, {
      version: 1,
      backup_id: id,
      created_at: now.toISOString(),
      files,
    });
    createdPaths.push(manifestPath);
    fs.chmodSync(manifestPath, 0o600);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const createdPath of createdPaths.reverse()) {
      try {
        unlinkIfPresent(createdPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Backup failed and cleanup was incomplete: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
    throw error;
  } finally {
    controlStore?.close();
    telemetryStore?.close();
  }

  // Retention runs only after the complete new set has been published. If it
  // fails, the new verified set remains available and the CLI reports failure.
  const prunedIds = pruneOlderBackupSets(destination, options.keep, id);
  return { id, telemetryPath, controlPath, manifestPath, prunedIds };
}

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
  const sources = resolveSourcePaths(PROJECT_ROOT, process.env);
  const result = await runBackup({ ...args, ...sources });
  console.log(
    JSON.stringify({
      status: "ok",
      backup_id: result.id,
      manifest: result.manifestPath,
      pruned_backup_ids: result.prunedIds,
    }),
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (samePath(invokedPath, fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(`[backup] ${String(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  }
}
