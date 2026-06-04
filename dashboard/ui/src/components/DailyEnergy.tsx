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
    <span className="daily-net-badge" style={{ borderColor: color, color }}>
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
    <section className="section fade-in">
      <div className="section-head">
        <h2>Daily Energy</h2>
        <div className="daily-nav">
          <button
            className={`daily-nav__today-btn mono${isToday ? " daily-nav__today-btn--current" : ""}`}
            onClick={() => !isToday && setDate(today)}
            disabled={isToday}
            title="Jump to today"
          >
            today
          </button>
          <button
            className="daily-nav__btn"
            onClick={() => setDate(offsetDate(date, -1))}
            title="Previous day"
          >
            ‹
          </button>
          <span className="daily-nav__date mono">{formatDayShort(date)}</span>
          <button
            className={`daily-nav__btn${!canGoNext ? " daily-nav__btn--disabled" : ""}`}
            onClick={() => canGoNext && setDate(offsetDate(date, 1))}
            title="Next day"
            disabled={!canGoNext}
          >
            ›
          </button>
        </div>
      </div>

      <div className="daily-card">
        {isLoading && !data ? (
          <div className="daily-card__body">
            <div className="daily-col daily-col--nums">
              <div className="daily-skel daily-skel--sm" />
              <div className="daily-skel daily-skel--lg" />
              <div className="daily-skel daily-skel--lg" />
              <div className="daily-skel daily-skel--md" style={{ marginTop: 8 }} />
            </div>
            <div className="daily-col daily-col--detail">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="daily-skel daily-skel--md" />
              ))}
            </div>
            <div className="daily-col daily-col--chart daily-col--chart-skeleton" />
          </div>
        ) : (
          <div
            className="daily-card__body"
            style={{ opacity: isFetching ? 0.5 : 1, transition: "opacity 0.15s" }}
          >
            {/* ── col 1: numbers ── */}
            <div className="daily-col daily-col--nums">
              <div className="daily-col__head mono">
                {formatDateLong(date)}
                {selected && (
                  <span className="daily-coverage">
                    {" "}{selected.coverage_pct}% · {selected.snapshot_count} pts
                  </span>
                )}
              </div>
              {selected ? (
                <>
                  <div className="daily-big-row">
                    <span className="daily-big-label">Solar</span>
                    <span className="daily-big-val" style={{ color: C.solar }}>
                      {kwhStr(selected.solar_kwh)}<small> kWh</small>
                    </span>
                  </div>
                  <div className="daily-big-row">
                    <span className="daily-big-label">Load</span>
                    <span className="daily-big-val" style={{ color: C.load }}>
                      {kwhStr(selected.load_kwh)}<small> kWh</small>
                    </span>
                  </div>
                  <div className="daily-col__divider" />
                  <div className="daily-big-row daily-big-row--net">
                    <span className="daily-big-label">Net</span>
                    <NetBadge net={selected.net_kwh} />
                  </div>
                </>
              ) : (
                <div className="daily-nodata mono">no data for this day</div>
              )}
            </div>

            {/* ── col 2: flow breakdown ── */}
            <div className="daily-col daily-col--detail">
              <div className="daily-col__head mono">Flow breakdown</div>
              {selected ? (
                <div className="daily-breakdown">
                  <div className="daily-breakdown__row">
                    <span style={{ color: C.solar }}>PV → Load</span>
                    <span>{kwhStr(selected.pv_to_load_kwh)} kWh</span>
                  </div>
                  <div className="daily-breakdown__row">
                    <span style={{ color: C.charge }}>PV → Batt</span>
                    <span>{kwhStr(selected.pv_to_battery_kwh)} kWh</span>
                  </div>
                  <div className="daily-breakdown__row">
                    <span style={{ color: C.discharge }}>Batt → Load</span>
                    <span>{kwhStr(selected.battery_to_load_kwh)} kWh</span>
                  </div>
                  <div className="daily-breakdown__row">
                    <span style={{ color: C.grid }}>Grid → Load</span>
                    <span>{kwhStr(selected.grid_to_load_kwh)} kWh</span>
                  </div>
                </div>
              ) : (
                <div className="daily-nodata mono">—</div>
              )}
            </div>

            {/* ── col 3: 7-day chart ── */}
            <div className="daily-col daily-col--chart">
              <div className="daily-col__head mono">7-day comparison</div>
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
