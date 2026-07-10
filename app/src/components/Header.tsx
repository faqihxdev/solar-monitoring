import { useEffect, useState } from "react";
import { BatteryCharging, Maximize2, Minimize2 } from "lucide-react";
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
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
  const fullscreenSupported = typeof document.documentElement.requestFullscreen === "function";

  async function toggleFullscreen() {
    if (fullscreenBusy || !fullscreenSupported) return;
    setFullscreenBusy(true);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Ignore rejected fullscreen requests (e.g. blocked by browser policy).
    } finally {
      setFullscreenBusy(false);
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
  }

  return (
    <header className="animate-[fadein_0.5s_ease_both] flex items-center justify-between gap-4 lg:gap-6">
      <div className="flex min-w-0 items-center gap-2.5 text-lg font-bold leading-tight tracking-wide lg:gap-3 lg:text-xl">
        <BatteryCharging className="size-7 shrink-0 text-solar lg:size-9" strokeWidth={2} />
        <span>Solar Monitoring</span>
      </div>

      <div className="flex min-w-0 items-center gap-2 lg:gap-3">
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

        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-card border border-line bg-panel text-dim transition-colors hover:border-line-hi hover:text-text disabled:cursor-default disabled:opacity-45"
          onClick={toggleFullscreen}
          disabled={fullscreenBusy || !fullscreenSupported}
          aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {isFullscreen ? <Minimize2 size={13} strokeWidth={1.8} /> : <Maximize2 size={13} strokeWidth={1.8} />}
        </button>
      </div>
    </header>
  );
}
