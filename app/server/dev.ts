import { spawn, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";

interface Proc {
  name: string;
  command: string;
  args: string[];
  color: string;
}

const procs: Proc[] = [
  { name: "api", command: "pnpm", args: ["dev:api"], color: "\x1b[34m" },
  { name: "poller", command: "pnpm", args: ["poller"], color: "\x1b[33m" },
  { name: "ui", command: "pnpm", args: ["dev:ui"], color: "\x1b[32m" },
];

const reset = "\x1b[0m";
const children: ChildProcess[] = [];
let shuttingDown = false;

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

for (const proc of procs) {
  const child = spawn(proc.command, proc.args, {
    cwd: process.cwd(),
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.stderr?.on("data", (chunk) => prefix(proc.name, proc.color, chunk));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[${proc.name}] exited with ${code ?? "signal"}`);
      stopAll(code ?? 1);
    }
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
