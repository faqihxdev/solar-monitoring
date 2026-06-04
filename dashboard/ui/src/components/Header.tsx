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
    <header className="header fade-in">
      <div className="brand">
        <div className="brand__mark">
          <BatteryCharging size={22} strokeWidth={1.6} />
        </div>
        <div>
          <div className="brand__title">
            Solar <span>Monitor</span>
          </div>
          <div className="brand__id mono">{deviceSn || "—"}</div>
        </div>
      </div>

      <div className="live">
        <span className="live__row mono">
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
          className="live__sub mono"
          title={lastIso ? `Poll time: ${fullTime(new Date(lastIso).getTime())}` : ""}
        >
          polled {freshness}
        </span>
      </div>
    </header>
  );
}
