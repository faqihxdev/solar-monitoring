import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const isWindows = process.platform === "win32";
const execFileAsync = promisify(execFile);
const DEFAULT_API_PORT = 43871;
const DEFAULT_UI_PORT = 43872;
const pnpmCommand = "pnpm";
const UI_RESTART_DELAY_MS = 1200;

function readPort(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer in [1024, 65535], got "${raw}"`);
  }
  return parsed;
}

const apiPort = readPort("DESS_DASHBOARD_PORT", DEFAULT_API_PORT);
const uiPort = readPort("DESS_UI_PORT", DEFAULT_UI_PORT);

interface Proc {
  name: string;
  command: string;
  args: string[];
  color: string;
  restartOnFailure?: boolean;
  restartDelayMs?: number;
}

const procs: Proc[] = [
  { name: "api", command: pnpmCommand, args: ["dev:api"], color: "\x1b[34m" },
  { name: "poller", command: pnpmCommand, args: ["poller"], color: "\x1b[33m" },
  {
    name: "ui",
    command: pnpmCommand,
    args: ["dev:ui"],
    color: "\x1b[32m",
    restartOnFailure: true,
    restartDelayMs: UI_RESTART_DELAY_MS,
  },
];

const reset = "\x1b[0m";
const children = new Set<ChildProcess>();
let shuttingDown = false;

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function listWindowsListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"]);
    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[0] !== "TCP") continue;
      const localAddress = cols[1] ?? "";
      const state = (cols[3] ?? "").toUpperCase();
      if (!localAddress.endsWith(`:${port}`) || state !== "LISTENING") continue;
      const pid = parseNumber(cols[4]);
      if (pid) pids.add(pid);
    }
    return [...pids];
  } catch (error) {
    console.warn(`[dev] failed to inspect port ${port} on Windows: ${formatError(error)}`);
    return [];
  }
}

async function listUnixListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return stdout
      .split(/\r?\n/)
      .map((line) => parseNumber(line.trim()))
      .filter((value): value is number => value !== null);
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return [];
    if (code === "ENOENT") {
      console.warn(`[dev] lsof not available, cannot auto-free port ${port}`);
      return [];
    }
    throw error;
  }
}

async function listListeningPids(port: number): Promise<number[]> {
  return isWindows ? listWindowsListeningPids(port) : listUnixListeningPids(port);
}

async function forceKillPid(pid: number): Promise<void> {
  if (isWindows) {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/F", "/T"]);
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function freePort(port: number): Promise<void> {
  const pids = (await listListeningPids(port)).filter((pid) => pid !== process.pid);
  if (pids.length === 0) return;
  console.warn(`[dev] port ${port} is busy, killing PID(s): ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      await forceKillPid(pid);
    } catch (error) {
      console.warn(`[dev] failed to kill PID ${pid}: ${formatError(error)}`);
    }
  }
}

function prefix(name: string, color: string, chunk: Buffer | string): void {
  const lines = String(chunk).split(/\r?\n/);
  for (const line of lines) {
    if (line) process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
  }
}

function stopAll(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(isWindows ? undefined : "SIGTERM");
  }
  setTimeout(() => process.exit(code), 100);
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function getSpawnTarget(proc: Proc): { command: string; args: string[] } {
  if (!isWindows) return { command: proc.command, args: proc.args };
  // Git Bash + Node on Windows can throw EINVAL when spawning .cmd directly.
  const commandLine = [proc.command, ...proc.args].map(quoteCmdArg).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
}

function spawnProc(proc: Proc, childEnv: NodeJS.ProcessEnv): void {
  const target = getSpawnTarget(proc);
  const child = spawn(target.command, target.args, {
    cwd: process.cwd(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.stderr?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;

    const exitState = code ?? signal ?? "signal";
    if (proc.restartOnFailure && code !== 0) {
      const delayMs = proc.restartDelayMs ?? UI_RESTART_DELAY_MS;
      console.error(`[${proc.name}] exited with ${exitState}; restarting in ${delayMs}ms`);
      setTimeout(() => {
        if (!shuttingDown) spawnProc(proc, childEnv);
      }, delayMs);
      return;
    }

    console.error(`[${proc.name}] exited with ${exitState}`);
    stopAll(typeof code === "number" ? code : 1);
  });
}

async function main(): Promise<void> {
  await freePort(apiPort);
  await freePort(uiPort);

  const childEnv = {
    ...process.env,
    DESS_DASHBOARD_PORT: String(apiPort),
    DESS_UI_PORT: String(uiPort),
  };

  for (const proc of procs) {
    spawnProc(proc, childEnv);
  }
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

main().catch((error) => {
  console.error(`[dev] ${formatError(error)}`);
  process.exit(1);
});
