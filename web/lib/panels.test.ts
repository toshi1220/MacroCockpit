import { describe, expect, it } from "vitest";
import { PANEL_GROUPS, PANEL_KEYS } from "./panels";

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
