import { describe, expect, it } from "vitest";
import { PANEL_GROUPS, PANEL_KEYS, range52w } from "./panels";

// カテゴリ別セクション化(表示グループ)の整合性検証:
// 25パネル全てがいずれかのグループに「漏れなく・重複なく」属することを保証する。
describe("PANEL_GROUPS(カテゴリ別セクション)", () => {
  it("グループ内のkeyに重複がない", () => {
    const grouped = PANEL_GROUPS.flatMap((g) => g.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("全25パネルが漏れなくいずれかのグループに属する(過不足なし)", () => {
    const grouped = PANEL_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual([...PANEL_KEYS].sort());
    expect(PANEL_KEYS).toHaveLength(25);
  });

  it("セクションは6つ", () => {
    expect(PANEL_GROUPS).toHaveLength(6);
  });
});

// 52週レンジバーの純関数: 直近365日窓の min/max と現在位置(0..1)
describe("range52w(52週レンジ)", () => {
  it("窓内の min/max と現在位置を返す(365日より古い観測は無視)", () => {
    const obs = [
      { date: "2024-01-10", value: 999 }, // 365日窓の外 → 無視される
      { date: "2025-08-01", value: 100 },
      { date: "2025-12-01", value: 200 },
      { date: "2026-06-01", value: 150 },
    ];
    const r = range52w(obs);
    expect(r).not.toBeNull();
    expect(r!.min).toBe(100);
    expect(r!.max).toBe(200);
    expect(r!.pos).toBeCloseTo(0.5); // (150-100)/(200-100)
  });

  it("最新値が52週高値なら pos=1、安値なら pos=0", () => {
    const high = range52w([
      { date: "2026-01-01", value: 10 },
      { date: "2026-06-01", value: 30 },
    ]);
    expect(high!.pos).toBe(1);
    const low = range52w([
      { date: "2026-01-01", value: 30 },
      { date: "2026-06-01", value: 10 },
    ]);
    expect(low!.pos).toBe(0);
  });

  it("空配列は null、窓内が単一値なら pos=0.5", () => {
    expect(range52w([])).toBeNull();
    const flat = range52w([
      { date: "2026-05-01", value: 5 },
      { date: "2026-06-01", value: 5 },
    ]);
    expect(flat!.min).toBe(5);
    expect(flat!.max).toBe(5);
    expect(flat!.pos).toBe(0.5);
  });
});
