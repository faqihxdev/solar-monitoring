import { useMemo, useState } from "react";
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

export default function App() {
  const [hours, setHours] = useState(6);

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
            hours={hours}
            setHours={setHours}
            history={history.data}
            voltage={voltage.data}
            voltageThresholds={voltageThresholds}
            latest={latest}
          />

          <DailyEnergy />

          <ControlCenter voltageThresholds={voltageThresholds} />
        </>
      )}
    </div>
  );
}
