import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";

const isWindows = process.platform === "win32";
const execFileAsync = promisify(execFile);
const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = path.resolve(appRoot, "..");
const DEFAULT_API_PORT = 43871;
const DEFAULT_UI_PORT = 43872;
const DEFAULT_API_TARGET = "http://127.0.0.1:14387";
const DEFAULT_REMOTE_HOST = "127.0.0.1";
const DEFAULT_SSH_HOST = "your-vps-host";
const DEFAULT_WINDOWS_SSH_BIN = "C:/Windows/System32/OpenSSH/ssh.exe";
const DEFAULT_UNIX_SSH_BIN = "ssh";
const SSH_UI_START_DELAY_MS = 450;

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

interface Proc {
  name: string;
  command: string;
  args: string[];
  color: string;
}

const reset = "\x1b[0m";
const children = new Set<ChildProcess>();
let shuttingDown = false;
let startedUi = false;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePort(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer in [1, 65535], got "${raw}"`);
  }
  return parsed;
}

function readTarget(): URL {
  const raw = (process.env.DESS_DEV_API_TARGET ?? DEFAULT_API_TARGET).trim();
  const target = new URL(raw);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`DESS_DEV_API_TARGET must use http/https protocol, got "${target.protocol}" in "${raw}"`);
  }
  if (target.pathname !== "/" || target.search || target.hash) {
    throw new Error(`DESS_DEV_API_TARGET must be an origin only (no path/query/hash), got "${raw}"`);
  }
  if (!target.port) {
    throw new Error(`DESS_DEV_API_TARGET must include an explicit port, got "${raw}"`);
  }
  if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
    throw new Error(`DESS_DEV_API_TARGET host must be localhost or 127.0.0.1, got "${target.hostname}"`);
  }
  return target;
}

function readRemotePort(): number {
  return parsePort(
    process.env.DESS_VPS_TUNNEL_REMOTE_PORT ?? process.env.DESS_DASHBOARD_PORT ?? String(DEFAULT_API_PORT),
    "DESS_VPS_TUNNEL_REMOTE_PORT",
  );
}

function readUiPort(): number {
  return parsePort(process.env.DESS_UI_PORT ?? String(DEFAULT_UI_PORT), "DESS_UI_PORT");
}

function readSshBin(): string {
  const explicit = process.env.DESS_VPS_SSH_BIN?.trim();
  if (explicit) return explicit;
  return isWindows ? DEFAULT_WINDOWS_SSH_BIN : DEFAULT_UNIX_SSH_BIN;
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function getSpawnTarget(proc: Proc): { command: string; args: string[] } {
  if (!isWindows) return { command: proc.command, args: proc.args };
  const commandLine = [proc.command, ...proc.args].map(quoteCmdArg).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
}

function prefix(name: string, color: string, chunk: Buffer | string): void {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line) process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
  }
}

async function killChild(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (isWindows) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/F", "/T"]);
      return;
    } catch {
      // Best effort fallback when taskkill fails on an already-exited process.
    }
  }
  try {
    child.kill(isWindows ? undefined : "SIGTERM");
  } catch {
    // Ignore kill races on shutting down children.
  }
}

async function stopAll(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const kills = [...children].map((child) => killChild(child));
  await Promise.allSettled(kills);
  setTimeout(() => process.exit(code), 50);
}

function spawnProc(proc: Proc): void {
  const target = getSpawnTarget(proc);
  const child = spawn(target.command, target.args, {
    cwd: appRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.stderr?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.on("error", (error) => {
    children.delete(child);
    if (shuttingDown) return;
    console.error(`[${proc.name}] failed to start: ${formatError(error)}`);
    void stopAll(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    const exitState = code ?? signal ?? "signal";
    console.error(`[${proc.name}] exited with ${exitState}`);
    void stopAll(typeof code === "number" ? code : 1);
  });
}

async function assertPortIsFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = createServer();
    tester.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Local tunnel port ${port} is already in use. Stop the existing tunnel/process or change DESS_DEV_API_TARGET.`,
          ),
        );
        return;
      }
      reject(error);
    });
    tester.once("listening", () => tester.close(() => resolve()));
    tester.listen(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  const target = readTarget();
  const localTunnelPort = parsePort(target.port, "DESS_DEV_API_TARGET port");
  const uiPort = readUiPort();
  const remoteHost = process.env.DESS_VPS_TUNNEL_REMOTE_HOST?.trim() || DEFAULT_REMOTE_HOST;
  const remotePort = readRemotePort();
  const sshHost = process.env.DESS_VPS_SSH_HOST?.trim() || DEFAULT_SSH_HOST;
  const sshBin = readSshBin();

  await assertPortIsFree(localTunnelPort);

  console.log(
    `[dev:vps] Starting tunnel ${localTunnelPort} -> ${remoteHost}:${remotePort} via ${sshHost}; UI on http://localhost:${uiPort}/`,
  );
  console.log("[dev:vps] Press Ctrl+C once to stop both tunnel and UI.");

  spawnProc({
    name: "tunnel",
    command: sshBin,
    args: ["-N", "-L", `${localTunnelPort}:${remoteHost}:${remotePort}`, sshHost],
    color: "\x1b[35m",
  });

  setTimeout(() => {
    if (shuttingDown || startedUi) return;
    startedUi = true;
    spawnProc({
      name: "ui",
      command: "pnpm",
      args: ["dev:ui"],
      color: "\x1b[32m",
    });
  }, SSH_UI_START_DELAY_MS);
}

process.on("SIGINT", () => {
  void stopAll(0);
});
process.on("SIGTERM", () => {
  void stopAll(0);
});

main().catch((error) => {
  console.error(`[dev:vps] ${formatError(error)}`);
  process.exit(1);
});
