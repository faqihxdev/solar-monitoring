import { useEffect, useState } from "react";
import { BatteryCharging } from "lucide-react";
import type { Reading } from "../api";
import { relativeAge, fullTime } from "../format";

const DEVICE_TIME_DRIFT_MS = 45 * 60 * 1000;

interface Props {
  deviceSn: string;
  latest: Reading | null;
  online: boolean;
  polledAtMs: number | null;
  lastIso: string | null;
}

export default function Header({ deviceSn, latest, online, polledAtMs, lastIso }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ageMs = polledAtMs != null ? now - polledAtMs : null;
  const rawDeviceAtMs =
    latest?.device_gts != null && /^\d+$/.test(String(latest.device_gts))
      ? Number(latest.device_gts)
      : null;
  const deviceAtMs = rawDeviceAtMs != null && rawDeviceAtMs < 1_000_000_000_000
    ? rawDeviceAtMs * 1000
    : rawDeviceAtMs;
  const deviceClockDrifted =
    deviceAtMs != null &&
    polledAtMs != null &&
    Math.abs(polledAtMs - deviceAtMs) >= DEVICE_TIME_DRIFT_MS;
  const displayAtMs = deviceClockDrifted ? polledAtMs : deviceAtMs;
  const deviceAgeMs = deviceAtMs != null ? now - deviceAtMs : null;

  let ledClass = "led";
  let freshness = "—";
  if (!online) {
    ledClass = "led led--off";
    freshness = "Offline";
  } else if (ageMs != null) {
    freshness = relativeAge(ageMs);
  }
  if (online && (deviceAgeMs ?? ageMs ?? 0) > 120000) ledClass = "led led--stale";

  return (
    <header className="animate-[fadein_0.5s_ease_both] flex flex-wrap items-start justify-between gap-3 rounded-card border border-line bg-panel px-3 py-3 sm:items-center sm:px-4 sm:py-3.5">
      <div className="flex items-center gap-3 sm:gap-3.5">
        <div className="grid h-9 w-9 place-items-center rounded-card border border-line-hi text-solar sm:h-10 sm:w-10">
          <BatteryCharging size={20} strokeWidth={1.6} />
        </div>
        <div>
          <div className="text-lg font-bold leading-none tracking-wide sm:text-xl">
            Solar <span className="font-light text-dim">Monitor</span>
          </div>
          <div className="mt-1 font-mono text-xs tracking-wide tabular-nums text-faint">{deviceSn || "—"}</div>
        </div>
      </div>

      <div className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
        <span className="flex items-center gap-2 font-mono text-xs tabular-nums sm:text-sm">
          <span className={ledClass} />
          <span
            title={
              displayAtMs != null
                ? deviceClockDrifted && deviceAtMs != null
                  ? `Poll time: ${fullTime(displayAtMs)} (device time: ${fullTime(deviceAtMs)})`
                  : `${fullTime(displayAtMs)} device time`
                : ""
            }
          >
            {displayAtMs != null ? fullTime(displayAtMs) : freshness}
          </span>
        </span>
        <span
          className="font-mono text-xs tabular-nums text-faint"
          title={lastIso ? `Poll time: ${fullTime(new Date(lastIso).getTime())}` : ""}
        >
          polled {freshness}
        </span>
      </div>
    </header>
  );
}
