"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChangeData, PanelData } from "@/lib/types";

const UP = "#73BF69";
const DOWN = "#FF7383";
const SUB = "#9DA5B8";

function changeColor(dir: 1 | 0 | -1): string {
  return dir > 0 ? UP : dir < 0 ? DOWN : SUB;
}

function Change({ c }: { c: ChangeData }) {
  return (
    <span
      className="font-mono [font-variant-numeric:tabular-nums]"
      style={{ color: changeColor(c.dir) }}
    >
      {c.text}
    </span>
  );
}

export default function IndicatorPanel({ panel: p }: { panel: PanelData }) {
  const hasData = p.latest !== null && p.points.length > 0;

  const fmt = (v: number) =>
    p.prefix +
    (p.signed && v > 0 ? "+" : "") +
    v.toLocaleString("en-US", {
      minimumFractionDigits: p.decimals,
      maximumFractionDigits: p.decimals,
    }) +
    p.suffix;

  return (
    <section className="flex flex-col rounded-lg border border-[#2C3235] bg-[#181B1F] px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] leading-4 text-[#9DA5B8]">
          {p.title}
          {p.note && <span className="ml-1 text-[9px]">({p.note})</span>}
        </span>
        {hasData && p.delta && (
          <span className="text-right text-[11px] leading-4">
            <Change c={p.delta} />
          </span>
        )}
      </div>

      {hasData ? (
        <>
          <div className="mt-0.5 font-mono text-[22px] leading-7 text-[#F5F6F8] [font-variant-numeric:tabular-nums]">
            {p.latest}
          </div>

          <div className="mt-1 h-24 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={p.points}
                margin={{ top: 2, right: 2, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="#2C3235"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: SUB }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={60}
                  tickFormatter={(d: string) => d.slice(0, 7)}
                />
                <YAxis
                  domain={
                    p.includeZero
                      ? [
                          (dataMin: number) => Math.min(0, dataMin),
                          (dataMax: number) => Math.max(0, dataMax),
                        ]
                      : ["auto", "auto"]
                  }
                  tick={{ fontSize: 9, fill: SUB }}
                  tickLine={false}
                  axisLine={false}
                  width={42}
                  tickFormatter={(v: number) =>
                    v.toLocaleString("en-US", { maximumFractionDigits: p.decimals })
                  }
                />
                <Tooltip
                  isAnimationActive={false}
                  cursor={{ stroke: "#2C3235" }}
                  content={({ active, payload, label }) =>
                    active && payload && payload.length ? (
                      <div className="rounded border border-[#2C3235] bg-[#181B1F] px-2 py-1 text-[11px]">
                        <div className="text-[#9DA5B8]">{String(label)}</div>
                        <div className="font-mono text-[#F5F6F8] [font-variant-numeric:tabular-nums]">
                          {fmt(Number(payload[0].value))}
                        </div>
                      </div>
                    ) : null
                  }
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={p.color}
                  strokeWidth={1.5}
                  fill={p.color}
                  fillOpacity={0.12}
                  dot={false}
                  activeDot={{ r: 2, fill: p.color, stroke: "none" }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {(p.mom || p.yoy) && (
            <div className="mt-1 flex gap-3 text-[10px] text-[#9DA5B8]">
              {p.mom && (
                <span>
                  前月比 <Change c={p.mom} />
                </span>
              )}
              {p.yoy && (
                <span>
                  前年比 <Change c={p.yoy} />
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex h-40 items-center justify-center text-[12px] text-[#9DA5B8]">
          取得待ち
        </div>
      )}
    </section>
  );
}
