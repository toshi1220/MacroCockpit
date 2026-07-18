import type { RegimeStripData } from "@/lib/types";

/**
 * レジーム・ストリップ(§6.3 / §8 Phase 3: ルールエンジン版)
 * 色は config/regime.yaml のルール判定で決める(§6.4 の閾値色の流儀):
 *   シナリオ整合=緑 #73BF69 / 中立=グレー #2C3235 / 逆行=赤 #FF7383
 * ▲▼は「実際の方向」を示す(色とは独立)。
 * 右端に summary(例: 「シナリオ継続 7/8」)を小さく表示。
 * 設定エラー時は全セル中立グレー+「ルール設定エラー」小表示に退避する。
 */
export default function RegimeStrip({ data }: { data: RegimeStripData }) {
  const { cells, summary, error } = data;
  return (
    <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-2">
      <div className="grid flex-1 grid-cols-4 gap-1 md:grid-cols-8">
        {cells.map((c) => {
          const style =
            c.state === "aligned"
              ? "bg-[#73BF69] text-[#111217]"
              : c.state === "contrary"
                ? "bg-[#FF7383] text-[#111217]"
                : "bg-[#2C3235] text-[#9DA5B8]";
          const arrow = c.dir === "up" ? "▲" : c.dir === "down" ? "▼" : "―";
          return (
            <div
              key={c.key}
              className={`flex items-center justify-between rounded px-2 py-1 text-[11px] font-medium ${style}`}
            >
              <span className="font-mono [font-variant-numeric:tabular-nums]">
                {c.label}
              </span>
              <span>{arrow}</span>
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
