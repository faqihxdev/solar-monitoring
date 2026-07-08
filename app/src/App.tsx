import { useEffect, useMemo, useRef, useState } from "react";
import Header from "./components/Header";
import EnergyFlow from "./components/EnergyFlow";
import Charts from "./components/Charts";
import DailyEnergy from "./components/DailyEnergy";
import ControlCenter from "./components/ControlCenter";
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

function withLiveControlValues(thresholds: ThresholdEntry[], controls: ControlEntry[] | undefined): ThresholdEntry[] {
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
  const rangeMs = range === "today" ? 24 * 3600_000 : hoursForRange(range) * 3600_000;
  const domainStartMs = range === "today"
    ? jakartaMidnightMsForDate(chartDate)
    : endOfDayMs - rangeMs;
  return Math.ceil((Date.now() - domainStartMs) / 3600_000) + 2;
}

export default function App() {
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

  const socThresholds = thresholds.data?.thresholds.battery_soc ?? [];
  const voltageThresholds = useMemo(
    () => withLiveControlValues(thresholds.data?.thresholds.battery_voltage ?? [], controls.data?.controls),
    [thresholds.data?.thresholds.battery_voltage, controls.data?.controls],
  );

  // Rated output ("Power Value Setting" control, in W) used as the load gauge max.
  const powerValueControl = controls.data?.controls.find((c) => c.id === "power_value");
  const loadMaxKw =
    powerValueControl?.raw_value != null && Number.isFinite(Number(powerValueControl.raw_value))
      ? Number(powerValueControl.raw_value) / 1000
      : null;

  const firstLoad = summary.isLoading && !summary.data;

  return (
    <div className="mx-auto max-w-7xl px-2.5 pb-10 pt-2.5 sm:px-4 sm:pb-14 sm:pt-4 lg:px-6 lg:pb-16">
      <Header
        deviceSn={deviceSn}
        latest={latest}
        online={online}
        polledAtMs={polledAtMs}
        lastIso={latest?.polled_at_iso ?? null}
      />

      {firstLoad ? (
        <div className="p-10 text-center font-mono text-dim">Connecting to device…</div>
      ) : (
        <>
          <div className="mt-4">
            <EnergyFlow
              latest={latest}
              summary={summary.data?.summary ?? null}
              socThresholds={socThresholds}
              voltageThresholds={voltageThresholds}
              history={history.data?.points ?? []}
              loadMaxKw={loadMaxKw}
            />
          </div>

          <Charts
            range={range}
            setRange={setRange}
            chartDate={date}
            setChartDate={setDate}
            history={history.data}
            voltage={voltage.data}
            voltageThresholds={voltageThresholds}
            latest={latest}
          />

          <DailyEnergy date={date} setDate={setDate} />

          <ControlCenter voltageThresholds={voltageThresholds} />
        </>
      )}
    </div>
  );
}
