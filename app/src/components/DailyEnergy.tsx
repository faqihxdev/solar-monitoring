import { ArrowRight, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDailyEnergy } from "../hooks";
import { formatDayShort } from "../format";
import { C, FONT } from "../theme";
import { DateNavigator, EmptyState, SectionHeading } from "./ui";

interface Props {
  date: string;
  setDate: (date: string) => void;
}
export default function DailyEnergy({ date, setDate }: Props) {
  const { data, isLoading, isFetching, isError, refetch } = useDailyEnergy(
    date,
    7,
  );
  const days = data?.daily ?? [];
  const selected = days.find((day) => day.date === date);
  const flows = selected
    ? [
        {
          label: "Solar to home",
          value: selected.pv_to_load_kwh,
          color: C.solar,
        },
        {
          label: "Solar to battery",
          value: selected.pv_to_battery_kwh,
          color: C.charge,
        },
        {
          label: "Battery to home",
          value: selected.battery_to_load_kwh,
          color: C.discharge,
        },
        {
          label: "Grid to home",
          value: selected.grid_to_load_kwh,
          color: C.grid,
        },
      ]
    : [];
  return (
    <section className="daily-section" aria-label="Daily energy">
      <SectionHeading title="Daily energy">
        <DateNavigator date={date} onChange={setDate} />
      </SectionHeading>
      <div className="daily-panel" aria-busy={isFetching}>
        {isLoading ? (
          <div className="daily-skeleton" role="status">
            Loading daily energy…
          </div>
        ) : isError ? (
          <EmptyState
            title="Daily energy is unavailable"
            description="The monitoring service could not return this period."
          >
            <button
              className="button button-secondary"
              onClick={() => void refetch()}
            >
              Retry daily energy
            </button>
          </EmptyState>
        ) : (
          <>
            <div className="daily-summary">
              <span className="panel-caption">
                {formatDayShort(date)}
                {isFetching && <span>Updating…</span>}
              </span>
              {selected ? (
                <>
                  <div className="daily-total">
                    <span>
                      <i style={{ background: C.solar }} />
                      Generated
                    </span>
                    <strong>
                      {selected.solar_kwh.toFixed(2)}
                      <small>kWh</small>
                    </strong>
                  </div>
                  <div className="daily-total">
                    <span>
                      <i style={{ background: C.load }} />
                      Consumed
                    </span>
                    <strong>
                      {selected.load_kwh.toFixed(2)}
                      <small>kWh</small>
                    </strong>
                  </div>
                  <div className="daily-balance">
                    {selected.net_kwh >= 0 ? (
                      <ArrowUpRight size={16} />
                    ) : (
                      <ArrowDownLeft size={16} />
                    )}
                    <span>
                      {Math.abs(selected.net_kwh).toFixed(2)} kWh{" "}
                      {selected.net_kwh >= 0 ? "surplus" : "shortfall"}
                    </span>
                  </div>
                  <p className="coverage-note">
                    {selected.coverage_pct}% data coverage
                    <span>Totals reflect recorded readings.</span>
                  </p>
                </>
              ) : (
                <EmptyState
                  title="No readings for this day"
                  description="Choose another date to see recorded energy."
                />
              )}
            </div>
            <div className="daily-chart">
              <div className="daily-chart-heading">
                <span className="panel-caption">Past 7 days</span>
                <div className="flow-legend">
                  <span>
                    <i style={{ background: C.solar }} />
                    Generated
                  </span>
                  <span>
                    <i style={{ background: C.load }} />
                    Consumed
                  </span>
                </div>
              </div>
              {days.length ? (
                <ResponsiveContainer width="100%" height={205}>
                  <BarChart
                    data={days}
                    barGap={4}
                    margin={{ top: 12, right: 0, left: -22, bottom: 0 }}
                    accessibilityLayer
                  >
                    <CartesianGrid
                      stroke={C.line}
                      vertical={false}
                      strokeDasharray="3 4"
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDayShort}
                      tick={{
                        fill: C.textDim,
                        fontSize: 11,
                        fontFamily: FONT.display,
                      }}
                      axisLine={false}
                      tickLine={false}
                      dy={8}
                      minTickGap={14}
                    />
                    <YAxis
                      tick={{ fill: C.textFaint, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickCount={4}
                    />
                    <Tooltip
                      cursor={{ fill: "#ffffff", fillOpacity: 0.035 }}
                      contentStyle={{
                        background: C.panelHi,
                        borderColor: C.lineHi,
                        borderRadius: 8,
                        color: C.text,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) => formatDayShort(String(v))}
                      formatter={(v: number) => [`${Number(v).toFixed(2)} kWh`]}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="solar_kwh"
                      name="Generated"
                      fill={C.solar}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={22}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="load_kwh"
                      name="Consumed"
                      fill={C.load}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={22}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No comparison data yet" />
              )}
            </div>
            <div className="daily-breakdown">
              <span className="panel-caption">Where the energy went</span>
              {flows.length ? (
                flows.map((flow) => (
                  <div className="daily-flow" key={flow.label}>
                    <span>
                      <i style={{ background: flow.color }} />
                      {flow.label}
                    </span>
                    <strong>
                      {flow.value.toFixed(2)}
                      <small>kWh</small>
                    </strong>
                  </div>
                ))
              ) : (
                <span className="text-dim">No recorded flows</span>
              )}
              <a href="#history" className="text-button">
                View trends
                <ArrowRight size={14} />
              </a>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
