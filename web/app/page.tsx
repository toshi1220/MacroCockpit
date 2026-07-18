import IndicatorPanel from "@/components/IndicatorPanel";
import RegimeStrip from "@/components/RegimeStrip";
import { getDashboardData } from "@/lib/panels";

// リクエスト毎にDBを読む(ビルド時静的化を禁止)
export const dynamic = "force-dynamic";

export default function Home() {
  const { updatedAt, panels, regime } = getDashboardData();

  return (
    <main className="min-h-screen bg-[#111217] px-3 py-3 text-[#F5F6F8]">
      <header className="mb-2 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-wide">Macro Cockpit</h1>
        <span className="text-[11px] text-[#9DA5B8]">
          最終更新: {updatedAt ?? "未取得"}
        </span>
      </header>

      <RegimeStrip cells={regime} />

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        {panels.map((p) => (
          <IndicatorPanel key={p.key} panel={p} />
        ))}
      </div>
    </main>
  );
}
