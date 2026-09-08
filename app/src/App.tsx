import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import Header from "./components/Header";
import EnergyFlow from "./components/EnergyFlow";
import type { ControlEntry, ThresholdEntry } from "./api";
import {
  useConfig,
  useSummary,
  useThresholds,
  useControls,
  useHistory,
  useVoltage,
} from "./hooks";
import type { RangeKey } from "./format";
import {
  hoursForRange,
  todayJkt,
  offsetDate,
  jakartaMidnightMsForDate,
} from "./format";

const Charts = lazy(() => import("./components/Charts"));
const DailyEnergy = lazy(() => import("./components/DailyEnergy"));
const ControlCenter = lazy(() => import("./components/ControlCenter"));
function withLiveControlValues(
  thresholds: ThresholdEntry[],
  controls: ControlEntry[] | undefined,
): ThresholdEntry[] {
  if (!controls?.length) return thresholds;
  const byField = new Map(controls.map((control) => [control.id, control]));
  return thresholds.map((threshold) => {
    const control = byField.get(threshold.field_id);
    const liveValue = control?.pack_value ?? null;
    if (liveValue == null || !Number.isFinite(liveValue)) return threshold;
    return { ...threshold, value: liveValue, from_device: true };
  });
}

function chartFetchHours(range: RangeKey, chartDate: string): number {
  const today = todayJkt();
  if (chartDate === today) return hoursForRange(range);

  const nextDay = offsetDate(chartDate, 1);
  const endOfDayMs = jakartaMidnightMsForDate(nextDay);
  const rangeMs =
    range === "today" ? 24 * 3600_000 : hoursForRange(range) * 3600_000;
  const domainStartMs =
    range === "today"
      ? jakartaMidnightMsForDate(chartDate)
      : endOfDayMs - rangeMs;
  return Math.ceil((Date.now() - domainStartMs) / 3600_000) + 2;
}

export default function App() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const [range, setRange] = useState<RangeKey>("12h");
  // Shared date used by both Trends and Daily Energy.
  // Navigating either section's date arrows syncs both.
  // Clicking a range button (6H, 12H…) resets to today.
  const [date, setDate] = useState(() => todayJkt());

  // The app is left open continuously on a display, so `date` (captured once above)
  // would otherwise get stuck on whichever day the page happened to load on. Poll for
  // the real calendar day changing (Jakarta time) and, if the view was tracking "today",
  // advance it to the new day. A manually-selected past day is left untouched.
  const lastTodayRef = useRef(todayJkt());
  useEffect(() => {
    const checkRollover = () => {
      const current = todayJkt();
      if (current === lastTodayRef.current) return;
      const previousToday = lastTodayRef.current;
      lastTodayRef.current = current;
      setDate((prev) => (prev === previousToday ? current : prev));
    };
    const id = window.setInterval(checkRollover, 60_000);
    document.addEventListener("visibilitychange", checkRollover);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", checkRollover);
    };
  }, []);

  const hours = chartFetchHours(range, date);

  const config = useConfig();
  const summary = useSummary();
  const thresholds = useThresholds();
  const controls = useControls();
  const history = useHistory(hours);
  const voltage = useVoltage(hours);

  const latest = summary.data?.latest ?? null;
  const deviceSn = config.data?.device_sn ?? summary.data?.device_sn ?? "";

  const polledAtMs = latest?.polled_at != null ? latest.polled_at * 1000 : null;
  const online = !summary.isError;
  const fresh = online && polledAtMs != null && now - polledAtMs < 5 * 60_000;

  const voltageThresholds = useMemo(
    () =>
      withLiveControlValues(
        thresholds.data?.thresholds.battery_voltage ?? [],
        controls.data?.controls,
      ),
    [thresholds.data?.thresholds.battery_voltage, controls.data?.controls],
  );

  // Rated output ("Power Value Setting" control, in W) used as the load gauge max.
  const powerValueControl = controls.data?.controls.find(
    (c) => c.id === "power_value",
  );
  const loadMaxKw =
    powerValueControl?.raw_value != null &&
    Number.isFinite(Number(powerValueControl.raw_value))
      ? Number(powerValueControl.raw_value) / 1000
      : null;

  const firstLoad = summary.isLoading && !summary.data;
  const selectDate = (next: string) => {
    setDate(next);
    setRange("today");
  };

  return (
    <div className="app-shell" id="overview">
      <Header
        online={online}
        fresh={fresh}
        loading={firstLoad}
        polledAtMs={polledAtMs}
      />
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading">
          <h1>Energy overview</h1>
          {deviceSn && <span className="system-identity">{deviceSn}</span>}
        </div>
        {firstLoad && (
          <div className="notice" role="status">
            <RefreshCw size={15} className="animate-spin" />
            Connecting…
          </div>
        )}
        {!firstLoad && (!online || !latest || !fresh) && (
          <div className="notice" role="status">
            <CircleAlert size={16} />
            <span>
              {!online
                ? "The monitoring service is unavailable."
                : !latest
                  ? "Waiting for the first device reading."
                  : "Telemetry is delayed."}{" "}
              {latest ? "Showing last known flow." : ""}
            </span>
            <button
              className="text-button"
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
            >
              <RefreshCw
                size={14}
                className={summary.isFetching ? "animate-spin" : ""}
              />
              Retry
            </button>
          </div>
        )}
        <EnergyFlow
          latest={latest}
          voltageThresholds={voltageThresholds}
          history={history.data?.points ?? []}
          loadMaxKw={loadMaxKw}
          fresh={fresh}
        />
        <Suspense
          fallback={
            <div className="page-loading" role="status">
              Loading trends and controls…
            </div>
          }
        >
          <div className="dashboard-section" id="history">
            {(history.isError || voltage.isError) && (
              <div className="notice" role="status">
                <CircleAlert size={16} />
                <span>Some historical readings could not be loaded.</span>
                <button
                  className="text-button"
                  onClick={() => {
                    void history.refetch();
                    void voltage.refetch();
                  }}
                >
                  Retry history
                </button>
              </div>
            )}
            <Charts
              range={range}
              setRange={setRange}
              chartDate={date}
              setChartDate={setDate}
              history={history.data}
              voltage={voltage.data}
              voltageThresholds={voltageThresholds}
              latest={latest}
              loading={history.isPending || voltage.isPending}
            />
          </div>
          <DailyEnergy date={date} setDate={selectDate} />
          <div className="dashboard-section" id="controls">
            <ControlCenter voltageThresholds={voltageThresholds} />
          </div>
          <InitialSectionScroll />
        </Suspense>
      </main>
    </div>
  );
}

// Old section URLs remain useful as anchors within the single dashboard.
// Run after the lazy sections mount so the target exists at its final position.
function InitialSectionScroll() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id !== "history" && id !== "controls") return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
