import type { JsonRecord } from "./types";

interface ReadinessStore {
  summary(deviceSn: string): JsonRecord;
}

interface ReadinessOptions {
  nowSeconds?: number;
  maxTelemetryAgeSeconds: number;
  shuttingDown?: boolean;
}

type ReadinessStatus =
  | "ready"
  | "database_unreadable"
  | "missing_telemetry"
  | "stale_telemetry"
  | "shutting_down";

interface ReadinessBody {
  ready: boolean;
  status: ReadinessStatus;
  server_now: number;
  checks: {
    database: { readable: boolean };
    telemetry: {
      fresh: boolean;
      last_polled_at: number | null;
      age_seconds: number | null;
      max_age_seconds: number;
    };
  };
}

export interface ReadinessResult {
  statusCode: 200 | 503;
  body: ReadinessBody;
}

export function checkReadiness(
  store: ReadinessStore,
  deviceSn: string,
  options: ReadinessOptions,
): ReadinessResult {
  const nowSeconds = options.nowSeconds ?? Date.now() / 1000;
  const maxAgeSeconds = Math.max(1, options.maxTelemetryAgeSeconds);
  const unavailable = (
    status: Exclude<ReadinessStatus, "ready">,
    databaseReadable: boolean,
    lastPolledAt: number | null = null,
    ageSeconds: number | null = null,
  ): ReadinessResult => ({
    statusCode: 503,
    body: {
      ready: false,
      status,
      server_now: nowSeconds,
      checks: {
        database: { readable: databaseReadable },
        telemetry: {
          fresh: false,
          last_polled_at: lastPolledAt,
          age_seconds: ageSeconds,
          max_age_seconds: maxAgeSeconds,
        },
      },
    },
  });

  if (options.shuttingDown) return unavailable("shutting_down", false);

  let summary: JsonRecord;
  try {
    summary = store.summary(deviceSn);
  } catch {
    return unavailable("database_unreadable", false);
  }

  const lastPolledAt = Number(summary.last_polled_at);
  if (!Number.isFinite(lastPolledAt) || lastPolledAt <= 0) {
    return unavailable("missing_telemetry", true);
  }

  const ageSeconds = nowSeconds - lastPolledAt;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    return unavailable("stale_telemetry", true, lastPolledAt, ageSeconds);
  }

  return {
    statusCode: 200,
    body: {
      ready: true,
      status: "ready",
      server_now: nowSeconds,
      checks: {
        database: { readable: true },
        telemetry: {
          fresh: true,
          last_polled_at: lastPolledAt,
          age_seconds: ageSeconds,
          max_age_seconds: maxAgeSeconds,
        },
      },
    },
  };
}
