import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeYoY,
  evaluateRegime,
  parseRegimeConfig,
  resolveSeriesChain,
  type Observation,
  type RegimeConfig,
} from "./regime";

// ---- テストヘルパー(ネットワーク・DB不要の純関数テスト) ------------------

/** [date, value] のリストから観測列を作る。 */
function obs(rows: [string, number][]): Observation[] {
  return rows.map(([date, value]) => ({ date, value }));
}

/** 1セルだけの最小構成 config を作る。 */
function oneCellConfig(cell: RegimeConfig["cells"][number]): RegimeConfig {
  return {
    defaults: { lookback_months: 3, flat_epsilon_rel: 0.001 },
    scenario: { name: "テスト", min_aligned: 1 },
    cells: [cell],
  };
}

const directionUpCell = (series: RegimeConfig["cells"][number]["series"]) =>
  oneCellConfig({
    key: "c",
    label: "C",
    series,
    rule: { type: "direction", expected: "up" },
  });

// ---- direction 型 ----------------------------------------------------------

describe("direction ルール", () => {
  it("上昇データ × expected: up → 整合(aligned)・▲", () => {
    const map = new Map([
      ["S", obs([["2026-01-01", 100], ["2026-04-01", 110]])],
    ]);
    const r = evaluateRegime(directionUpCell([{ id: "S", transform: "raw" }]), map);
    expect(r.cells[0]).toMatchObject({ state: "aligned", dir: "up" });
  });

  it("下落データ × expected: up → 逆行(contrary)・▼", () => {
    const map = new Map([
      ["S", obs([["2026-01-01", 110], ["2026-04-01", 100]])],
    ]);
    const r = evaluateRegime(directionUpCell([{ id: "S", transform: "raw" }]), map);
    expect(r.cells[0]).toMatchObject({ state: "contrary", dir: "down" });
  });

  it("下落データ × expected: down → 整合(aligned)", () => {
    const config = oneCellConfig({
      key: "c",
      label: "C",
      series: [{ id: "S", transform: "raw" }],
      rule: { type: "direction", expected: "down" },
    });
    const map = new Map([
      ["S", obs([["2026-01-01", 110], ["2026-04-01", 100]])],
    ]);
    expect(evaluateRegime(config, map).cells[0].state).toBe("aligned");
  });

  it("変化が flat_epsilon 未満 → 中立(neutral)", () => {
    // 基準100に対し±0.1%未満(diff=0.05)は変化なし
    const map = new Map([
      ["S", obs([["2026-01-01", 100], ["2026-04-01", 100.05]])],
    ]);
    const r = evaluateRegime(directionUpCell([{ id: "S", transform: "raw" }]), map);
    expect(r.cells[0]).toMatchObject({ state: "neutral", dir: "flat" });
  });

  it("データ欠損(系列なし・lookback以前の観測なし)→ 中立", () => {
    const config = directionUpCell([{ id: "S", transform: "raw" }]);
    // 系列そのものが無い
    expect(evaluateRegime(config, new Map()).cells[0].state).toBe("neutral");
    // 観測が1点だけで3ヶ月前の基準が無い
    const map = new Map([["S", obs([["2026-04-01", 100]])]]);
    expect(evaluateRegime(config, map).cells[0].state).toBe("neutral");
  });

  it("セル個別の lookback_months が defaults を上書きする", () => {
    // 直近6ヶ月では上昇、直近3ヶ月では下落のデータ
    const data = obs([
      ["2025-10-01", 100],
      ["2026-01-01", 120],
      ["2026-04-01", 110],
    ]);
    const map = new Map([["S", data]]);
    const base = directionUpCell([{ id: "S", transform: "raw" }]);
    expect(evaluateRegime(base, map).cells[0].state).toBe("contrary"); // 3ヶ月比較
    const overridden = oneCellConfig({
      key: "c",
      label: "C",
      series: [{ id: "S", transform: "raw" }],
      rule: { type: "direction", expected: "up", lookback_months: 6 },
    });
    expect(evaluateRegime(overridden, map).cells[0].state).toBe("aligned"); // 6ヶ月比較
  });
});

// ---- threshold 型 ----------------------------------------------------------

describe("threshold ルール", () => {
  const vixCell = oneCellConfig({
    key: "vix",
    label: "VIX",
    series: [{ id: "V", transform: "raw" }],
    rule: { type: "threshold", warn_above: 30 },
  });

  it("直近値が warn_above 超 → 逆行(警戒)", () => {
    const map = new Map([["V", obs([["2026-01-01", 15], ["2026-07-01", 35]])]]);
    expect(evaluateRegime(vixCell, map).cells[0].state).toBe("contrary");
  });

  it("直近値が警戒域でない → 整合(境界値ちょうどは平常)", () => {
    const map = new Map([["V", obs([["2026-01-01", 15], ["2026-07-01", 30]])]]);
    expect(evaluateRegime(vixCell, map).cells[0].state).toBe("aligned");
  });

  it("データ欠損 → 中立", () => {
    expect(evaluateRegime(vixCell, new Map()).cells[0].state).toBe("neutral");
  });

  it("warn_below 未満 → 逆行", () => {
    const config = oneCellConfig({
      key: "c",
      label: "C",
      series: [{ id: "S", transform: "raw" }],
      rule: { type: "threshold", warn_below: 0 },
    });
    const map = new Map([["S", obs([["2026-07-01", -0.5]])]]);
    expect(evaluateRegime(config, map).cells[0].state).toBe("contrary");
  });
});

// ---- 優先チェーンと yoy transform ------------------------------------------

describe("series 優先チェーン・transform", () => {
  it("第1候補が欠損なら第2候補で判定する", () => {
    const config = directionUpCell([
      { id: "PRIMARY", transform: "raw" },
      { id: "FALLBACK", transform: "raw" },
    ]);
    const map = new Map([
      ["PRIMARY", [] as Observation[]],
      ["FALLBACK", obs([["2026-01-01", 100], ["2026-04-01", 110]])],
    ]);
    expect(evaluateRegime(config, map).cells[0].state).toBe("aligned");
  });

  it("第1候補にデータがあれば第2候補は見ない", () => {
    const chain = [
      { id: "PRIMARY", transform: "raw" as const },
      { id: "FALLBACK", transform: "raw" as const },
    ];
    const map = new Map([
      ["PRIMARY", obs([["2026-01-01", 110], ["2026-04-01", 100]])], // 下落
      ["FALLBACK", obs([["2026-01-01", 100], ["2026-04-01", 110]])], // 上昇
    ]);
    expect(resolveSeriesChain(chain, map)).toEqual(map.get("PRIMARY"));
    expect(evaluateRegime(directionUpCell(chain), map).cells[0].state).toBe("contrary");
  });

  it("computeYoY: 前年同月比%(月初/月末の日付揺れは月キーで吸収)", () => {
    const yoy = computeYoY(
      obs([["2025-05-01", 100], ["2026-05-31", 103]])
    );
    expect(yoy).toHaveLength(1);
    expect(yoy[0].date).toBe("2026-05-31");
    expect(yoy[0].value).toBeCloseTo(3, 10);
  });

  it("yoy transform で判定する(YoY加速 → direction up 整合)", () => {
    // 指数は2025年中フラット、2026年にかけて上昇 → YoYは 1% → 3% に加速
    const index: [string, number][] = [];
    for (let m = 1; m <= 12; m++) {
      index.push([`2025-${String(m).padStart(2, "0")}-01`, 100]);
    }
    index.push(["2026-01-01", 101]); // YoY 1%
    index.push(["2026-02-01", 101]);
    index.push(["2026-03-01", 102]);
    index.push(["2026-04-01", 103]); // YoY 3%(3ヶ月前=1%より加速)
    const map = new Map([["CPI", obs(index)]]);
    const r = evaluateRegime(directionUpCell([{ id: "CPI", transform: "yoy" }]), map);
    expect(r.cells[0]).toMatchObject({ state: "aligned", dir: "up" });
  });
});

// ---- scenario 集計 ----------------------------------------------------------

describe("scenario 集計(summary)", () => {
  function configWithStates(minAligned: number, states: ("up" | "down" | "none")[]): {
    config: RegimeConfig;
    map: Map<string, Observation[]>;
  } {
    // expected: up のセルを並べ、データで aligned(up)/contrary(down)/neutral(none) を作る
    const map = new Map<string, Observation[]>();
    const cells = states.map((s, i) => {
      const id = `S${i}`;
      if (s === "up") map.set(id, obs([["2026-01-01", 100], ["2026-04-01", 110]]));
      else if (s === "down") map.set(id, obs([["2026-01-01", 110], ["2026-04-01", 100]]));
      return {
        key: `c${i}`,
        label: `C${i}`,
        series: [{ id, transform: "raw" as const }],
        rule: { type: "direction" as const, expected: "up" as const },
      };
    });
    return {
      config: {
        defaults: { lookback_months: 3, flat_epsilon_rel: 0.001 },
        scenario: { name: "テストシナリオ", min_aligned: minAligned },
        cells,
      },
      map,
    };
  }

  it("整合数 = min_aligned ちょうど → 「シナリオ継続」(境界)", () => {
    const { config, map } = configWithStates(2, ["up", "up", "none"]);
    const { summary } = evaluateRegime(config, map);
    expect(summary).toMatchObject({ aligned: 2, contrary: 0 });
    expect(summary.text).toBe("シナリオ継続 2/3");
  });

  it("整合数 = min_aligned - 1 → 「要注意」+逆行件数", () => {
    const { config, map } = configWithStates(2, ["up", "down", "none"]);
    const { summary } = evaluateRegime(config, map);
    expect(summary).toMatchObject({ aligned: 1, contrary: 1 });
    expect(summary.text).toBe("要注意 1/3(逆行1)");
  });

  it("min_aligned 以上でも逆行があれば件数を添える", () => {
    const { config, map } = configWithStates(2, ["up", "up", "down"]);
    const { summary } = evaluateRegime(config, map);
    expect(summary.text).toBe("シナリオ継続 2/3(逆行1)");
  });
});

// ---- 不正YAML・スキーマ検証 -------------------------------------------------

describe("parseRegimeConfig の検証", () => {
  const VALID = `
defaults: { lookback_months: 3, flat_epsilon_rel: 0.001 }
scenario: { name: "テスト", min_aligned: 1 }
cells:
  - key: a
    label: A
    series: [ { id: "S" } ]
    rule: { type: direction, expected: up }
`;

  it("正しいYAMLをパースできる(transform 省略時は raw)", () => {
    const config = parseRegimeConfig(VALID);
    expect(config.cells).toHaveLength(1);
    expect(config.cells[0].series[0]).toEqual({ id: "S", transform: "raw" });
    expect(config.defaults.lookback_months).toBe(3);
  });

  it("YAML構文エラー → 明確なエラーを投げる", () => {
    expect(() => parseRegimeConfig("cells: [ {")).toThrow(/regime\.yaml/);
  });

  it("rule.type が不正 → エラー", () => {
    const bad = VALID.replace("type: direction", "type: magic");
    expect(() => parseRegimeConfig(bad)).toThrow(/direction \| threshold/);
  });

  it("direction の expected 欠如/不正 → エラー", () => {
    const bad = VALID.replace("expected: up", "expected: sideways");
    expect(() => parseRegimeConfig(bad)).toThrow(/expected/);
  });

  it("lookback_months が非整数 → エラー(shiftMonthsが黙って壊れるのを防ぐ)", () => {
    const badDefault = VALID.replace("lookback_months: 3", "lookback_months: 1.5");
    expect(() => parseRegimeConfig(badDefault)).toThrow(/正の整数/);
    const badRule = VALID.replace(
      "rule: { type: direction, expected: up }",
      "rule: { type: direction, expected: up, lookback_months: 2.5 }"
    );
    expect(() => parseRegimeConfig(badRule)).toThrow(/正の整数/);
  });

  it("threshold で warn_above / warn_below 両方欠如 → エラー", () => {
    const bad = VALID.replace(
      "rule: { type: direction, expected: up }",
      "rule: { type: threshold }"
    );
    expect(() => parseRegimeConfig(bad)).toThrow(/warn_above/);
  });

  it("cells が空 / series が空 → エラー", () => {
    expect(() =>
      parseRegimeConfig(
        'defaults: { lookback_months: 3, flat_epsilon_rel: 0.001 }\nscenario: { name: "t", min_aligned: 1 }\ncells: []'
      )
    ).toThrow(/cells/);
    expect(() => parseRegimeConfig(VALID.replace('series: [ { id: "S" } ]', "series: []"))).toThrow(
      /series/
    );
  });

  it("defaults の数値が不正 → エラー", () => {
    expect(() =>
      parseRegimeConfig(VALID.replace("lookback_months: 3", 'lookback_months: "three"'))
    ).toThrow(/lookback_months/);
  });
});

// ---- 同梱の config/regime.yaml 自体の健全性 ---------------------------------

describe("config/regime.yaml(同梱の初期値)", () => {
  it("パース・検証を通り、8セル構成で現行実装と同じ既定値を持つ", () => {
    const p = path.resolve(process.cwd(), "..", "config", "regime.yaml");
    const config = parseRegimeConfig(fs.readFileSync(p, "utf-8"));
    expect(config.cells).toHaveLength(8);
    expect(config.defaults).toEqual({ lookback_months: 3, flat_epsilon_rel: 0.001 });
    expect(config.scenario.min_aligned).toBe(6);
    expect(config.cells.map((c) => c.label)).toEqual([
      "米CPI",
      "日CPI",
      "JGB10Y",
      "USDJPY",
      "金",
      "Fed B/S",
      "日銀B/S",
      "VIX",
    ]);
    // VIXのみ threshold、他は direction up
    expect(config.cells[7].rule).toEqual({ type: "threshold", warn_above: 30 });
    for (const cell of config.cells.slice(0, 7)) {
      expect(cell.rule).toEqual({ type: "direction", expected: "up" });
    }
  });
});
