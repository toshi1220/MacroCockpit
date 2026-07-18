import type { RegimeCellData } from "@/lib/types";

/**
 * レジーム・ストリップ(§6.3 MVP版)
 * 直近値が3ヶ月前より 上=緑 / 下=赤 / 変化±0.1%未満・欠損=グレー の静的表示。
 * ルールエンジンは Phase 3。
 */
export default function RegimeStrip({ cells }: { cells: RegimeCellData[] }) {
  return (
    <div className="grid grid-cols-4 gap-1 md:grid-cols-8">
      {cells.map((c) => {
        const style =
          c.dir === "up"
            ? "bg-[#73BF69] text-[#111217]"
            : c.dir === "down"
              ? "bg-[#FF7383] text-[#111217]"
              : "bg-[#2C3235] text-[#9DA5B8]";
        const arrow = c.dir === "up" ? "▲" : c.dir === "down" ? "▼" : "―";
        return (
          <div
            key={c.label}
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
  );
}
