import type { RegimeCellData, RegimeStripData } from "@/lib/types";

/**
 * レジーム・ストリップ(§6.3 / §8 Phase 3: ルールエンジン版)
 * 各セルを高さ約40pxの小型計器にする:
 *   上段: 指標略名+▲▼(実際の方向)、下段: 最新値(11px Roboto Mono)
 *   背景: 直近3ヶ月のマイクロスパークライン(1px線+12%フラット塗り)
 * 状態色は config/regime.yaml の判定(§6.4 の閾値色の流儀):
 *   整合=緑 #73BF69 / 逆行=赤 #FF7383 / 中立=サブテキスト色
 * 状態色は背景12%塗り+スパークラインが担い、テキストは本文色のまま。
 * 状態は色単独にせず、値の横に状態テキストチップ(整合/逆行/中立)を必ず併記する
 * (IndicatorPanel の警戒チップと同じ流儀: 状態色テキスト+12%チップ背景)。
 * 右端に summary(例: 「シナリオ継続 7/8」)を小さく表示。
 * 設定エラー時は全セル中立+「ルール設定エラー」小表示に退避する。
 */

const ALIGNED = "#73BF69";
const CONTRARY = "#FF7383";
const NEUTRAL = "#9DA5B8";

function stateColor(state: RegimeCellData["state"]): string {
  return state === "aligned" ? ALIGNED : state === "contrary" ? CONTRARY : NEUTRAL;
}

/** 状態のテキストラベル(色単独禁止のため常時併記) */
const STATE_LABEL: Record<RegimeCellData["state"], string> = {
  aligned: "整合",
  contrary: "逆行",
  neutral: "中立",
};

/**
 * マイクロスパークライン(SVGパス直書き)。viewBox 100x40 を preserveAspectRatio
 * "none" で引き伸ばし、線は non-scaling-stroke で1pxを維持する。
 */
function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 40;
  const padY = 6;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) =>
    span === 0 ? h / 2 : h - padY - ((v - min) / span) * (h - padY * 2);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
    .join("");
  const area = `${line}L${w},${h}L0,${h}Z`;
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
    >
      <path d={area} fill={color} fillOpacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function RegimeStrip({ data }: { data: RegimeStripData }) {
  const { cells, summary, error } = data;
  return (
    <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
      <div className="grid flex-1 grid-cols-4 gap-1 md:grid-cols-8">
        {cells.map((c) => {
          const color = stateColor(c.state);
          const arrow = c.dir === "up" ? "▲" : c.dir === "down" ? "▼" : "―";
          return (
            <div
              key={c.key}
              className="relative h-10 overflow-hidden rounded border border-[#2C3235]"
              style={{ backgroundColor: `${color}1F` /* 状態色12% */ }}
            >
              <Spark values={c.spark} color={color} />
              <div className="relative flex h-full flex-col justify-between px-2 py-1">
                {/* #DCE1EA はパネルタイトルと同じ意図的なトークン逸脱
                    (視認性向上のユーザー要望。IndicatorPanel 参照) */}
                <div className="flex items-center justify-between text-[11px] font-medium leading-none text-[#DCE1EA]">
                  <span className="truncate font-mono [font-variant-numeric:tabular-nums]">
                    {c.label}
                  </span>
                  <span>{arrow}</span>
                </div>
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-mono text-[11px] leading-none text-[#F5F6F8] [font-variant-numeric:tabular-nums]">
                    {c.value ?? "—"}
                  </span>
                  {/* 状態チップ: 色+テキスト併記(IndicatorPanel の警戒チップの流儀) */}
                  <span
                    className="shrink-0 rounded-[3px] px-1 text-[9px] leading-[13px]"
                    style={{ color, backgroundColor: `${color}1F` }}
                  >
                    {STATE_LABEL[c.state]}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {summary && (
        <span
          className="shrink-0 text-[11px] text-[#9DA5B8] [font-variant-numeric:tabular-nums]"
          title={summary.name}
        >
          {summary.text}
        </span>
      )}
      {error && (
        <span className="shrink-0 text-[11px] text-[#F2CC0C]">{error}</span>
      )}
    </div>
  );
}
