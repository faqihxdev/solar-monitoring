import { useState } from "react";
import type { DailyPoint } from "../api";
import { useDailyEnergy } from "../hooks";
import { todayJkt } from "../format";
import { C, FONT } from "../theme";

function offsetDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDateLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDayShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function kwhStr(v: number): string {
  return v.toFixed(2);
}

// 3-column layout:
//   col1 (nums)  ~200px  col2 (detail) ~200px  col3 (chart) flex:1 ≈ 800px
// VB_W is sized to match chart col width so fontSize in viewBox ≈ rendered px.
// VB_H / VB_W ratio determines bar chart height — use ~1:4 for a visible chart.
const VB_W = 720;
const VB_H = 160;
const VB_LABEL = 16;

interface BarChartProps {
  days: DailyPoint[];
  selectedDate: string;
}

function DailyBarChart({ days, selectedDate }: BarChartProps) {
  const maxKwh = Math.max(...days.flatMap((d) => [d.solar_kwh, d.load_kwh]), 0.5);
  const groupW = VB_W / days.length;
  const barW = Math.max(5, Math.floor((groupW - 14) / 2));
  const gap = 3;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H + VB_LABEL}`}
      width="100%"
      style={{ display: "block" }}
      preserveAspectRatio="xMidYMid meet"
    >
      {days.map((day, i) => {
        const gx = i * groupW;
        const sH = Math.max(2, (day.solar_kwh / maxKwh) * VB_H);
        const lH = Math.max(2, (day.load_kwh / maxKwh) * VB_H);
        const sX = gx + Math.floor((groupW - barW * 2 - gap) / 2);
        const lX = sX + barW + gap;
        const isSelected = day.date === selectedDate;

        return (
          <g key={day.date}>
            {isSelected && (
              <rect
                x={gx + 2}
                y={0}
                width={groupW - 4}
                height={VB_H + 4}
                fill={C.lineHi}
                fillOpacity={0.45}
                rx={2}
              />
            )}
            <rect
              x={sX}
              y={VB_H - sH}
              width={barW}
              height={sH}
              fill={C.solar}
              fillOpacity={isSelected ? 0.92 : 0.6}
              rx={1}
            />
            <rect
              x={lX}
              y={VB_H - lH}
              width={barW}
              height={lH}
              fill={C.load}
              fillOpacity={isSelected ? 0.65 : 0.32}
              rx={1}
            />
            <text
              x={gx + groupW / 2}
              y={VB_H + VB_LABEL - 2}
              textAnchor="middle"
              fontSize={9}
              fill={isSelected ? C.text : C.textFaint}
              fontFamily={FONT.mono}
              fontWeight={isSelected ? "600" : "400"}
            >
              {formatDayShort(day.date).split(" ")[0]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function NetBadge({ net }: { net: number }) {
  const over = net >= 0;
  const color = over ? C.charge : C.bad;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs font-semibold tracking-wider"
      style={{ borderColor: color, color }}
    >
      {over ? "▲" : "▼"} {over ? "OVER" : "UNDER"} {Math.abs(net).toFixed(2)} kWh
    </span>
  );
}

export default function DailyEnergy() {
  const today = todayJkt();
  const [date, setDate] = useState(today);
  const { data, isLoading, isFetching } = useDailyEnergy(date, 7);

  const isToday = date === today;
  const canGoNext = !isToday;
  const days = data?.daily ?? [];
  const selected = days.find((d) => d.date === date) ?? null;

  return (
    <section className="mt-6 animate-[fadein_0.5s_ease_both]">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2.5 border-b border-line pb-2 sm:mb-3 sm:gap-4">
        <h2 className="m-0 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-dim">
          Daily Energy
        </h2>
        <div className="inline-flex items-center gap-1.5">
          <button
            className={`inline-grid h-6.5 place-items-center rounded-card border px-2 font-mono text-xs leading-none tracking-wider ${
              isToday
                ? "cursor-default border-charge bg-charge/15 text-charge"
                : "cursor-pointer border-line bg-panel text-faint hover:border-line-hi hover:text-dim"
            }`}
            onClick={() => !isToday && setDate(today)}
            disabled={isToday}
            title="Jump to today"
          >
            today
          </button>
          <button
            className="grid h-6.5 w-6.5 cursor-pointer place-items-center rounded-card border border-line bg-panel p-0 text-base leading-none text-dim transition-colors hover:border-line-hi hover:text-text"
            onClick={() => setDate(offsetDate(date, -1))}
            title="Previous day"
          >
            ‹
          </button>
          <span className="inline-flex min-w-18 items-center justify-center gap-1.5 text-center font-mono text-xs tabular-nums text-dim">
            {formatDayShort(date)}
          </span>
          <button
            className={`grid h-6.5 w-6.5 place-items-center rounded-card border bg-panel p-0 text-base leading-none transition-colors ${
              !canGoNext
                ? "cursor-default border-line text-dim opacity-30"
                : "cursor-pointer border-line text-dim hover:border-line-hi hover:text-text"
            }`}
            onClick={() => canGoNext && setDate(offsetDate(date, 1))}
            title="Next day"
            disabled={!canGoNext}
          >
            ›
          </button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-panel">
        {isLoading && !data ? (
          <div className="grid min-h-44 grid-cols-1 items-stretch lg:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-2.5 px-3 py-3 lg:col-span-3 lg:border-r lg:border-line lg:px-4 lg:py-3.5">
              <div className="mb-2.5 h-2.5 w-1/2 animate-[skel-pulse_1.4s_ease-in-out_infinite] rounded bg-line" />
              <div className="mb-2.5 h-7 w-2/3 animate-[skel-pulse_1.4s_ease-in-out_infinite] rounded bg-line" />
              <div className="mb-2.5 h-7 w-2/3 animate-[skel-pulse_1.4s_ease-in-out_infinite] rounded bg-line" />
              <div className="mb-2.5 mt-2 h-3.5 w-4/5 animate-[skel-pulse_1.4s_ease-in-out_infinite] rounded bg-line" />
            </div>
            <div className="flex min-w-0 flex-col gap-2.5 px-3 py-3 lg:col-span-3 lg:border-r lg:border-line lg:px-4 lg:py-3.5">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="mb-2.5 h-3.5 w-4/5 animate-[skel-pulse_1.4s_ease-in-out_infinite] rounded bg-line"
                />
              ))}
            </div>
            <div className="flex min-h-32 min-w-0 flex-col justify-between px-3 py-3 opacity-30 lg:col-span-6 lg:min-h-36 lg:px-4 lg:py-3.5">
              <div className="h-full rounded-card bg-line" />
            </div>
          </div>
        ) : (
          <div
            className="grid min-h-44 grid-cols-1 items-stretch lg:grid-cols-12"
            style={{ opacity: isFetching ? 0.5 : 1, transition: "opacity 0.15s" }}
          >
            {/* ── col 1: numbers ── */}
            <div className="flex min-w-0 flex-col gap-2.5 px-3 py-3 lg:col-span-3 lg:border-r lg:border-line lg:px-4 lg:py-3.5">
              <div className="mb-1 border-b border-line pb-1.5 font-mono text-xs tracking-wide text-faint">
                {formatDateLong(date)}
                {selected && (
                  <span className="text-xs text-faint opacity-70">
                    {" "}{selected.coverage_pct}% · {selected.snapshot_count} pts
                  </span>
                )}
              </div>
              {selected ? (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-dim">Solar</span>
                    <span className="font-mono text-lg font-medium tracking-tight tabular-nums sm:text-xl" style={{ color: C.solar }}>
                      {kwhStr(selected.solar_kwh)}<small> kWh</small>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-dim">Load</span>
                    <span className="font-mono text-lg font-medium tracking-tight tabular-nums sm:text-xl" style={{ color: C.load }}>
                      {kwhStr(selected.load_kwh)}<small> kWh</small>
                    </span>
                  </div>
                  <div className="my-0.5 h-px bg-line" />
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-dim">Net</span>
                    <NetBadge net={selected.net_kwh} />
                  </div>
                </>
              ) : (
                <div className="py-2 font-mono text-xs tabular-nums text-faint">no data for this day</div>
              )}
            </div>

            {/* ── col 2: flow breakdown ── */}
            <div className="flex min-w-0 flex-col gap-2.5 px-3 py-3 lg:col-span-3 lg:border-r lg:border-line lg:px-4 lg:py-3.5">
              <div className="mb-1 border-b border-line pb-1.5 font-mono text-xs tracking-wide text-faint">
                Flow breakdown
              </div>
              {selected ? (
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between gap-2.5 font-mono text-xs text-dim">
                    <span style={{ color: C.solar }}>PV → Load</span>
                    <span className="text-text">{kwhStr(selected.pv_to_load_kwh)} kWh</span>
                  </div>
                  <div className="flex justify-between gap-2.5 font-mono text-xs text-dim">
                    <span style={{ color: C.charge }}>PV → Batt</span>
                    <span className="text-text">{kwhStr(selected.pv_to_battery_kwh)} kWh</span>
                  </div>
                  <div className="flex justify-between gap-2.5 font-mono text-xs text-dim">
                    <span style={{ color: C.discharge }}>Batt → Load</span>
                    <span className="text-text">{kwhStr(selected.battery_to_load_kwh)} kWh</span>
                  </div>
                  <div className="flex justify-between gap-2.5 font-mono text-xs text-dim">
                    <span style={{ color: C.grid }}>Grid → Load</span>
                    <span className="text-text">{kwhStr(selected.grid_to_load_kwh)} kWh</span>
                  </div>
                </div>
              ) : (
                <div className="py-2 font-mono text-xs tabular-nums text-faint">—</div>
              )}
            </div>

            {/* ── col 3: 7-day chart ── */}
            <div className="flex min-w-0 flex-col justify-between px-3 py-3 lg:col-span-6 lg:px-4 lg:py-3.5">
              <div className="mb-1 border-b border-line pb-1.5 font-mono text-xs tracking-wide text-faint">
                7-day comparison
              </div>
              {days.length > 1 && (
                <DailyBarChart days={days} selectedDate={date} />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
