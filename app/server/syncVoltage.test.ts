import assert from "node:assert/strict";
import test from "node:test";

import type { DessmonitorClient } from "./dessClient";
import type { TelemetryStore } from "./store";
import { syncVoltageForDate } from "./syncVoltage";
import type { DeviceSettings } from "./types";

const settings: DeviceSettings = {
  pn: "TEST-PN",
  sn: "TEST-SN",
  devcode: "6513",
  devaddr: "1",
  i18n: "en_US",
};

function detailsPage(rows: Array<[string, string]>) {
  return {
    dat: {
      title: [{ title: "Timestamp" }, { title: "Battery Voltage" }],
      row: rows.map((field) => ({ field })),
    },
  };
}

test("a multi-page voltage refresh is committed as one database batch", async () => {
  const pages = [
    detailsPage([
      ["2026-09-03 12:00:00", "51.2"],
      ["2026-09-03 12:05:00", "51.3"],
    ]),
    detailsPage([["2026-09-03 12:10:00", "51.4"]]),
  ];
  let pageIndex = 0;
  const client = {
    queryDeviceDataOneDayPaging: async () => pages[pageIndex++],
  } as unknown as DessmonitorClient;
  let legacyPageCommits = 0;
  const batches: unknown[][] = [];
  const store = {
    syncDetailsVoltage: () => {
      legacyPageCommits += 1;
      return 0;
    },
    syncDetailsVoltagePages: (_deviceSn: string, pagesToCommit: unknown[]) => {
      batches.push(pagesToCommit);
      return 3;
    },
  } as unknown as TelemetryStore;

  const count = await syncVoltageForDate(client, store, settings, "2026-09-03", {
    pagesize: 2,
  });

  assert.equal(pageIndex, 2);
  assert.equal(legacyPageCommits, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 2);
  assert.equal(count, 3);
});

test("voltage sync stops between pages when shutdown is requested", async () => {
  const shutdown = new AbortController();
  let requests = 0;
  const client = {
    queryDeviceDataOneDayPaging: async () => {
      requests += 1;
      shutdown.abort();
      return detailsPage([
        ["2026-09-03 12:00:00", "51.2"],
        ["2026-09-03 12:05:00", "51.3"],
      ]);
    },
  } as unknown as DessmonitorClient;
  const batches: unknown[][] = [];
  const store = {
    syncDetailsVoltage: () => 0,
    syncDetailsVoltagePages: (_deviceSn: string, pagesToCommit: unknown[]) => {
      batches.push(pagesToCommit);
      return 2;
    },
  } as unknown as TelemetryStore;

  const count = await syncVoltageForDate(client, store, settings, "2026-09-03", {
    pagesize: 2,
    signal: shutdown.signal,
  });

  assert.equal(requests, 1);
  assert.equal(batches.length, 1);
  assert.equal(count, 2);
});
