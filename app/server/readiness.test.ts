import assert from "node:assert/strict";
import test from "node:test";
import { checkReadiness } from "./readiness";

test("readiness is HTTP 200 after a successful database read with fresh telemetry", () => {
  let reads = 0;
  const result = checkReadiness(
    {
      summary: () => {
        reads += 1;
        return { last_polled_at: 995 };
      },
    },
    "device-1",
    { nowSeconds: 1_000, maxTelemetryAgeSeconds: 60 },
  );

  assert.equal(reads, 1);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    ready: true,
    status: "ready",
    server_now: 1_000,
    checks: {
      database: { readable: true },
      telemetry: {
        fresh: true,
        last_polled_at: 995,
        age_seconds: 5,
        max_age_seconds: 60,
      },
    },
  });
});

test("readiness is HTTP 503 when telemetry is stale or missing", () => {
  const stale = checkReadiness(
    { summary: () => ({ last_polled_at: 900 }) },
    "device-1",
    { nowSeconds: 1_000, maxTelemetryAgeSeconds: 60 },
  );
  const missing = checkReadiness(
    { summary: () => ({ last_polled_at: null }) },
    "device-1",
    { nowSeconds: 1_000, maxTelemetryAgeSeconds: 60 },
  );

  assert.equal(stale.statusCode, 503);
  assert.equal(stale.body.status, "stale_telemetry");
  assert.equal(stale.body.checks.telemetry.age_seconds, 100);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.status, "missing_telemetry");
});

test("readiness is HTTP 503 and does not leak errors when the database cannot be read", () => {
  const result = checkReadiness(
    {
      summary: () => {
        throw new Error("sensitive database path");
      },
    },
    "device-1",
    { nowSeconds: 1_000, maxTelemetryAgeSeconds: 60 },
  );

  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    ready: false,
    status: "database_unreadable",
    server_now: 1_000,
    checks: {
      database: { readable: false },
      telemetry: {
        fresh: false,
        last_polled_at: null,
        age_seconds: null,
        max_age_seconds: 60,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /sensitive database path/);
});

test("readiness becomes HTTP 503 without reading a closing database", () => {
  let reads = 0;
  const result = checkReadiness(
    {
      summary: () => {
        reads += 1;
        return { last_polled_at: 995 };
      },
    },
    "device-1",
    { nowSeconds: 1_000, maxTelemetryAgeSeconds: 60, shuttingDown: true },
  );

  assert.equal(reads, 0);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.status, "shutting_down");
});
