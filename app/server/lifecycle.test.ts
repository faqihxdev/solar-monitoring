import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ShutdownCoordinator,
  installProcessShutdownHandlers,
  interruptibleDelay,
} from "./lifecycle";

test("shutdown drains once, then closes resources", async () => {
  const events: string[] = [];
  let releaseDrain: (() => void) | undefined;
  const drainGate = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const shutdown = new ShutdownCoordinator({
    drain: async (signal) => {
      events.push(`drain:${signal}`);
      await drainGate;
      events.push("drained");
    },
    close: () => {
      events.push("closed");
    },
  });

  const first = shutdown.request("SIGTERM");
  const second = shutdown.request("SIGINT");

  assert.equal(first, second);
  assert.equal(shutdown.requested, true);
  assert.equal(shutdown.reason, "SIGTERM");
  assert.deepEqual(events, ["drain:SIGTERM"]);

  releaseDrain?.();
  await first;
  assert.deepEqual(events, ["drain:SIGTERM", "drained", "closed"]);
});

test("shutdown still closes resources when draining fails", async () => {
  let closed = false;
  const shutdown = new ShutdownCoordinator({
    drain: async () => {
      throw new Error("drain failed");
    },
    close: () => {
      closed = true;
    },
  });

  await assert.rejects(shutdown.request("SIGTERM"), /drain failed/);
  assert.equal(closed, true);
});

test("poll delay can be interrupted immediately by shutdown", async () => {
  const shutdown = new ShutdownCoordinator({ close: () => undefined });
  const delay = interruptibleDelay(60_000, shutdown.signal);

  void shutdown.request("SIGTERM");

  assert.equal(await delay, "aborted");
});

test("SIGTERM and SIGINT handlers route through one shutdown request", async () => {
  const source = new EventEmitter();
  const reasons: string[] = [];
  const shutdown = new ShutdownCoordinator({
    drain: (signal) => {
      reasons.push(signal);
    },
    close: () => undefined,
  });
  const uninstall = installProcessShutdownHandlers(shutdown, {
    source,
    onError: (error) => assert.fail(String(error)),
  });

  source.emit("SIGTERM");
  source.emit("SIGINT");
  await shutdown.done;
  uninstall();

  assert.deepEqual(reasons, ["SIGTERM"]);
  assert.equal(source.listenerCount("SIGTERM"), 0);
  assert.equal(source.listenerCount("SIGINT"), 0);
});
