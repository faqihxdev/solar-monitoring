import { useEffect, useState } from "react";
import { BatteryCharging } from "lucide-react";
import type { Reading } from "../api";
import { relativeAge, clockTime, fullTime } from "../format";

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

  let freshness = "—";
  if (!online) {
    freshness = "Offline";
  } else if (ageMs != null) {
    freshness = relativeAge(ageMs);
  }

  const timeLabel = displayAtMs != null ? clockTime(displayAtMs) : freshness;
  const timeTitle =
    displayAtMs != null
      ? deviceClockDrifted && deviceAtMs != null
        ? `Poll time: ${fullTime(displayAtMs)} (device time: ${fullTime(deviceAtMs)})`
        : `${fullTime(displayAtMs)} device time`
      : "";
  const polledTitle = lastIso ? `Poll time: ${fullTime(new Date(lastIso).getTime())}` : "";
  const mobileTitle = [deviceSn, timeTitle, polledTitle].filter(Boolean).join("\n");

  return (
    <header className="animate-[fadein_0.5s_ease_both] flex items-center justify-between gap-4 lg:gap-6">
      <div className="flex min-w-0 items-center gap-2.5 text-lg font-bold leading-tight tracking-wide lg:gap-3 lg:text-xl">
        <BatteryCharging className="size-7 shrink-0 text-solar lg:size-9" strokeWidth={2} />
        <span>Solar System</span>
      </div>

      <div
        className="flex shrink-0 items-center gap-x-2 font-mono text-sm tabular-nums lg:hidden"
        title={mobileTitle}
      >
        <span>{timeLabel}</span>
        <span className="text-faint" aria-hidden>
          ·
        </span>
        <span className="text-faint">{freshness}</span>
      </div>

      <div className="hidden items-center gap-x-3 font-mono text-sm tabular-nums lg:flex lg:shrink-0">
        <span className="max-w-[18rem] truncate text-faint">{deviceSn || "—"}</span>
        <span className="text-faint" aria-hidden>
          ·
        </span>
        <span title={timeTitle}>{timeLabel}</span>
        <span className="text-faint" aria-hidden>
          ·
        </span>
        <span className="text-faint" title={polledTitle}>
          {freshness}
        </span>
      </div>
    </header>
  );
}
