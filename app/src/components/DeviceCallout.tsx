import {
  DEVICE_NAMES,
  type DeviceId,
  type EnergyConnection,
} from "../energyViewModel";

export interface SceneProps {
  connections: EnergyConnection[];
  selected: DeviceId;
  onSelect: (id: DeviceId) => void;
  soc: number | null;
  motion: boolean;
}

export const SCENE_DEVICE_IDS: DeviceId[] = [
  "solar",
  "grid",
  "inverter",
  "battery",
  "home",
];

// Name, live value and source caption shown on every scene's device labels.
export function DeviceCallout({
  id,
  connections,
  soc,
}: {
  id: DeviceId;
  connections: EnergyConnection[];
  soc: number | null;
}) {
  const connection = connections.find((c) => c.id === id);
  return (
    <>
      <span>{DEVICE_NAMES[id]}</span>
      <strong>
        {id === "battery"
          ? soc == null
            ? "—"
            : `${Math.round(soc)}%`
          : (connection?.value ?? "DC / AC")}
      </strong>
      {connection?.flowDetail && (
        <span className="battery-flow-detail">{connection.flowDetail}</span>
      )}
      {connection && (
        <small>
          {connection.minimum
            ? "Estimated minimum"
            : connection.inferred
              ? "Estimated power"
              : connection.label}
        </small>
      )}
    </>
  );
}
