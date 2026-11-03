import { useEffect, useState } from "react";
import {
  Activity,
  CircleAlert,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import {
  DISPLAY_TIME_LABEL,
  DISPLAY_TIME_ZONE,
  fullTime,
  relativeAge,
} from "../format";
import { IconButton } from "./ui";

const localClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface Props {
  online: boolean;
  fresh: boolean;
  polledAtMs: number | null;
  loading: boolean;
  deviceSn: string;
  notice?: { text: string; retrying: boolean; onRetry: () => void } | null;
}

export default function Header({
  online,
  fresh,
  polledAtMs,
  loading,
  deviceSn,
  notice,
}: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => {
      clearInterval(tick);
      document.removeEventListener("fullscreenchange", sync);
    };
  }, []);
  const status = loading
    ? "Connecting"
    : !online
      ? "Offline"
      : !polledAtMs
        ? "Waiting for data"
        : fresh
          ? "Connected"
          : "Delayed";
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      setFullscreenError("");
    } catch {
      setFullscreenError("Full screen is unavailable in this browser.");
    }
  }
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          {deviceSn && <span className="system-identity">{deviceSn}</span>}
          {notice && (
            <div className="header-notice" role="status">
              <CircleAlert size={13} />
              <span>{notice.text}</span>
              <button
                type="button"
                className="header-retry"
                disabled={notice.retrying}
                onClick={notice.onRetry}
              >
                <RefreshCw
                  size={12}
                  className={notice.retrying ? "animate-spin" : ""}
                />
                Retry
              </button>
            </div>
          )}
          <div className="header-status">
            <time
              className="local-clock"
              aria-label="Jakarta local time"
              dateTime={new Date(now).toISOString()}
            >
              {localClock.format(now)} <small>{DISPLAY_TIME_LABEL}</small>
            </time>
            <span className="connection-status">
              <span
                className={`status-dot ${fresh ? "is-live" : !online ? "is-offline" : ""}`}
              />
              {status}
            </span>
            <span
              className="last-update"
              title={
                polledAtMs == null
                  ? undefined
                  : `${fullTime(polledAtMs)} ${DISPLAY_TIME_LABEL}`
              }
            >
              {polledAtMs == null
                ? "No update yet"
                : `Updated ${relativeAge(now - polledAtMs)}`}
            </span>
            <IconButton
              label={fullscreen ? "Exit full screen" : "Enter full screen"}
              onClick={toggleFullscreen}
              disabled={!document.fullscreenEnabled}
              aria-pressed={fullscreen}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          </div>
        </div>
      </header>
      {fullscreenError && (
        <p className="fullscreen-message" role="status">
          <Activity size={14} />
          {fullscreenError}
        </p>
      )}
    </>
  );
}
