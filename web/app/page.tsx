import IndicatorPanel from "@/components/IndicatorPanel";
import RegimeStrip from "@/components/RegimeStrip";
import { getDashboardData, PANEL_GROUPS } from "@/lib/panels";

// リクエスト毎にDBを読む(ビルド時静的化を禁止)
export const dynamic = "force-dynamic";

export default function Home() {
  const { updatedAt, fetchHealth, panels, regime } = getDashboardData();
  const byKey = new Map(panels.map((p) => [p.key, p]));

  return (
    <main className="min-h-screen bg-[#111217] px-3 py-3 text-[#F5F6F8]">
      <header className="mb-2 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-wide">Macro Cockpit</h1>
        <span className="flex items-baseline gap-2 text-[11px] text-[#9DA5B8]">
          <span>最終更新: {updatedAt ?? "未取得"}</span>
          {fetchHealth && (
            // 取得健全性: 最新fetchバッチの ok/全系列。error>0 のみ警告色
            <span
              className="rounded-[4px] border border-[#2C3235] px-1.5 py-px font-mono [font-variant-numeric:tabular-nums]"
              style={
                fetchHealth.error > 0
                  ? {
                      color: "#F2CC0C",
                      backgroundColor: "rgba(242, 204, 12, 0.12)",
                      borderColor: "transparent",
                    }
                  : undefined
              }
            >
              {fetchHealth.ok}/{fetchHealth.total} ok
            </span>
          )}
        </span>
      </header>

      <RegimeStrip data={regime} />

      {/* カテゴリ別セクション(§6.1「並び順は見やすさ優先で入れ替えてよい」)。
          見出しはGrafanaのrowヘッダの流儀: 装飾なし・右側へヘアラインを伸ばす */}
      <div className="mt-3">
        {PANEL_GROUPS.map((g) => {
          const groupPanels = g.keys
            .map((k) => byKey.get(k))
            .filter((p) => p !== undefined);
          return (
            <section key={g.title} className="mt-4 first:mt-0">
              <h2 className="mb-1.5 flex items-center gap-3 text-[12px] font-medium tracking-wide text-[#9DA5B8]">
                {g.title}
                <span aria-hidden className="flex-1 border-t border-[#2C3235]" />
              </h2>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                {groupPanels.map((p) => (
                  <IndicatorPanel key={p.key} panel={p} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
