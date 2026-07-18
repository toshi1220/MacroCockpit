import yaml from "js-yaml";

/**
 * レジーム判定エンジン(SPEC §8 Phase 3)。
 * 判定ルールの単一の正は config/regime.yaml。このモジュールは
 *   1) YAMLテキストのパースとスキーマ検証(parseRegimeConfig)
 *   2) 観測値マップに対するルール評価(evaluateRegime)
 * のみを行う純関数群で、fs・DB・ネットワークに依存しない(テスト可能性のため)。
 */

// ---- 型 --------------------------------------------------------------------

export type Observation = { date: string; value: number };

export type Direction = "up" | "down" | "flat";
export type CellState = "aligned" | "contrary" | "neutral";

export type DirectionRule = {
  type: "direction";
  expected: "up" | "down";
  lookback_months?: number; // 省略時 defaults.lookback_months
};

export type ThresholdRule = {
  type: "threshold";
  warn_above?: number; // 直近値がこれを超えたら逆行
  warn_below?: number; // 直近値がこれを下回ったら逆行
};

export type RegimeRule = DirectionRule | ThresholdRule;

export type SeriesRef = {
  id: string;
  transform: "raw" | "yoy";
};

export type RegimeCellConfig = {
  key: string;
  label: string;
  series: SeriesRef[]; // ソース優先チェーン(先頭からデータが存在する最初の候補を採用)
  rule: RegimeRule;
};

export type RegimeConfig = {
  defaults: { lookback_months: number; flat_epsilon_rel: number };
  scenario: { name: string; min_aligned: number };
  cells: RegimeCellConfig[];
};

export type RegimeCellResult = {
  key: string;
  label: string;
  state: CellState; // 色を決める(整合=緑/逆行=赤/中立=グレー)
  dir: Direction; // ▲▼(実際の方向)を決める
};

export type RegimeSummary = {
  text: string; // 例: 「シナリオ継続 7/8」「要注意 4/8(逆行2)」
  name: string; // scenario.name
  aligned: number;
  contrary: number;
  total: number;
};

export type RegimeResult = {
  cells: RegimeCellResult[];
  summary: RegimeSummary;
};

// ---- 日付・派生系列ヘルパー(純関数。panels.ts からも利用) ----------------

export function shiftMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, daysInMonth);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** date 以前で最も近い観測を二分探索で返す。 */
export function lastOnOrBefore(obs: Observation[], date: string): Observation | null {
  let lo = 0;
  let hi = obs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? obs[ans] : null;
}

/**
 * 月次系列の前年同月比%。ソースにより日付が月初/月末で揺れるため
 * 「YYYY-MM」キーで前年同月を引く(月次前提: 1ヶ月1観測)。
 */
export function computeYoY(obs: Observation[]): Observation[] {
  const byMonth = new Map<string, number>();
  for (const o of obs) byMonth.set(o.date.slice(0, 7), o.value);
  const out: Observation[] = [];
  for (const o of obs) {
    const prevKey = `${String(Number(o.date.slice(0, 4)) - 1).padStart(4, "0")}${o.date.slice(4, 7)}`;
    const prev = byMonth.get(prevKey);
    if (prev !== undefined && prev !== 0) {
      out.push({ date: o.date, value: (o.value / prev - 1) * 100 });
    }
  }
  return out;
}

/** ソース優先チェーンの解決: transform 適用後にデータが存在する最初の候補の観測列。 */
export function resolveSeriesChain(
  series: SeriesRef[],
  obsMap: Map<string, Observation[]>
): Observation[] {
  for (const ref of series) {
    const raw = obsMap.get(ref.id) ?? [];
    const obs = ref.transform === "yoy" ? computeYoY(raw) : raw;
    if (obs.length > 0) return obs;
  }
  return [];
}

// ---- スキーマ検証付きパース ------------------------------------------------

function fail(msg: string): never {
  throw new Error(`regime.yaml が不正: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where} は数値が必要`);
  return v;
}

function asNonEmptyString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${where} は空でない文字列が必要`);
  return v;
}

function parseRule(v: unknown, where: string): RegimeRule {
  if (!isRecord(v)) fail(`${where}.rule はオブジェクトが必要`);
  if (v.type === "direction") {
    if (v.expected !== "up" && v.expected !== "down") {
      fail(`${where}.rule.expected は up | down が必要`);
    }
    const rule: DirectionRule = { type: "direction", expected: v.expected };
    if (v.lookback_months !== undefined) {
      const lb = asFiniteNumber(v.lookback_months, `${where}.rule.lookback_months`);
      // 非整数は shiftMonths が不正な日付文字列を生成し全セルが黙って中立化する。
      // silent failure にせず設定エラーとして退避表示に落とす
      if (lb <= 0 || !Number.isInteger(lb)) {
        fail(`${where}.rule.lookback_months は正の整数が必要`);
      }
      rule.lookback_months = lb;
    }
    return rule;
  }
  if (v.type === "threshold") {
    const rule: ThresholdRule = { type: "threshold" };
    if (v.warn_above !== undefined) {
      rule.warn_above = asFiniteNumber(v.warn_above, `${where}.rule.warn_above`);
    }
    if (v.warn_below !== undefined) {
      rule.warn_below = asFiniteNumber(v.warn_below, `${where}.rule.warn_below`);
    }
    if (rule.warn_above === undefined && rule.warn_below === undefined) {
      fail(`${where}.rule は warn_above / warn_below の少なくとも一方が必要`);
    }
    return rule;
  }
  fail(`${where}.rule.type は direction | threshold が必要`);
}

function parseSeries(v: unknown, where: string): SeriesRef[] {
  if (!Array.isArray(v) || v.length === 0) {
    fail(`${where}.series は1要素以上の配列が必要`);
  }
  return v.map((ref, i) => {
    if (!isRecord(ref)) fail(`${where}.series[${i}] はオブジェクトが必要`);
    const id = asNonEmptyString(ref.id, `${where}.series[${i}].id`);
    const t = ref.transform ?? "raw";
    if (t !== "raw" && t !== "yoy") {
      fail(`${where}.series[${i}].transform は raw | yoy が必要`);
    }
    return { id, transform: t };
  });
}

/**
 * YAMLテキストをパースしてスキーマ検証する。
 * 不正な場合は「どこがどう不正か」を含む Error を投げる(呼び出し側で退避表示に切り替える)。
 */
export function parseRegimeConfig(text: string): RegimeConfig {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    fail(`YAMLパース失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(doc)) fail("トップレベルはオブジェクトが必要");

  if (!isRecord(doc.defaults)) fail("defaults はオブジェクトが必要");
  const lookback = asFiniteNumber(doc.defaults.lookback_months, "defaults.lookback_months");
  if (lookback <= 0 || !Number.isInteger(lookback)) {
    fail("defaults.lookback_months は正の整数が必要");
  }
  const eps = asFiniteNumber(doc.defaults.flat_epsilon_rel, "defaults.flat_epsilon_rel");
  if (eps < 0) fail("defaults.flat_epsilon_rel は0以上が必要");

  if (!isRecord(doc.scenario)) fail("scenario はオブジェクトが必要");
  const name = asNonEmptyString(doc.scenario.name, "scenario.name");
  const minAligned = asFiniteNumber(doc.scenario.min_aligned, "scenario.min_aligned");
  if (minAligned < 0) fail("scenario.min_aligned は0以上が必要");

  if (!Array.isArray(doc.cells) || doc.cells.length === 0) {
    fail("cells は1要素以上の配列が必要");
  }
  const seenKeys = new Set<string>();
  const cells = doc.cells.map((c, i) => {
    const where = `cells[${i}]`;
    if (!isRecord(c)) fail(`${where} はオブジェクトが必要`);
    const key = asNonEmptyString(c.key, `${where}.key`);
    if (seenKeys.has(key)) fail(`${where}.key "${key}" が重複`);
    seenKeys.add(key);
    return {
      key,
      label: asNonEmptyString(c.label, `${where}.label`),
      series: parseSeries(c.series, where),
      rule: parseRule(c.rule, where),
    };
  });

  return {
    defaults: { lookback_months: lookback, flat_epsilon_rel: eps },
    scenario: { name, min_aligned: minAligned },
    cells,
  };
}

// ---- 評価 ------------------------------------------------------------------

/**
 * 直近値と「lookbackヶ月前以前の最も近い観測」の符号付き差分から実際の方向を返す。
 * 比率(latest/ref - 1)は基準値が負のとき符号が反転する(JGBマイナス金利期・
 * 日CPIデフレ期に実データあり)ため、符号付き差分で判定する。
 */
function actualDirection(
  obs: Observation[],
  lookbackMonths: number,
  flatEpsilonRel: number
): Direction {
  if (obs.length === 0) return "flat";
  const latest = obs[obs.length - 1];
  const ref = lastOnOrBefore(obs, shiftMonths(latest.date, -lookbackMonths));
  if (!ref) return "flat";
  const diff = latest.value - ref.value;
  // 価格系は基準値の±0.1%、ゼロ近傍の金利系は±0.001pt を「変化なし」とみなす
  const flatEps = flatEpsilonRel * Math.max(Math.abs(ref.value), 1);
  if (Math.abs(diff) < flatEps) return "flat";
  return diff > 0 ? "up" : "down";
}

function evaluateCell(
  cell: RegimeCellConfig,
  config: RegimeConfig,
  obsMap: Map<string, Observation[]>
): RegimeCellResult {
  const obs = resolveSeriesChain(cell.series, obsMap);
  const lookback =
    cell.rule.type === "direction"
      ? (cell.rule.lookback_months ?? config.defaults.lookback_months)
      : config.defaults.lookback_months;
  // ▲▼は常に「実際の方向」を示す(threshold型セルも同じ)。色は state で決める
  const dir = actualDirection(obs, lookback, config.defaults.flat_epsilon_rel);

  let state: CellState;
  if (cell.rule.type === "direction") {
    state = dir === "flat" ? "neutral" : dir === cell.rule.expected ? "aligned" : "contrary";
  } else {
    const latest = obs.length > 0 ? obs[obs.length - 1].value : null;
    if (latest === null) {
      state = "neutral";
    } else {
      const warned =
        (cell.rule.warn_above !== undefined && latest > cell.rule.warn_above) ||
        (cell.rule.warn_below !== undefined && latest < cell.rule.warn_below);
      state = warned ? "contrary" : "aligned";
    }
  }
  return { key: cell.key, label: cell.label, state, dir };
}

/**
 * 設定と観測値マップからストリップ全体を評価する。
 * summary: 整合セル数が min_aligned 以上なら「シナリオ継続」、未満なら「要注意」。
 * 逆行が1つでもあれば件数を添える。
 */
export function evaluateRegime(
  config: RegimeConfig,
  obsMap: Map<string, Observation[]>
): RegimeResult {
  const cells = config.cells.map((cell) => evaluateCell(cell, config, obsMap));
  const aligned = cells.filter((c) => c.state === "aligned").length;
  const contrary = cells.filter((c) => c.state === "contrary").length;
  const total = cells.length;
  const base = aligned >= config.scenario.min_aligned ? "シナリオ継続" : "要注意";
  const text = `${base} ${aligned}/${total}${contrary > 0 ? `(逆行${contrary})` : ""}`;
  return {
    cells,
    summary: { text, name: config.scenario.name, aligned, contrary, total },
  };
}
