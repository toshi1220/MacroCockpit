import fs from "node:fs";
import path from "node:path";
import {
  getFetchHealth,
  getLastFetchTs,
  getObservationsMap,
  type FetchHealth,
  type Observation,
} from "./db";
import {
  computeYoY,
  evaluateRegime,
  lastOnOrBefore,
  parseRegimeConfig,
  resolveSeriesChain,
  shiftMonths,
  type RegimeConfig,
} from "./regime";
import type {
  ChangeData,
  PanelData,
  Range52Data,
  ReferenceLineData,
  RegimeStripData,
} from "./types";

const GREEN = "#73BF69"; // 主系列(価格・指数・B/S系)
const BLUE = "#5794F2"; // 金利・リスク系
const WARN = "#F2CC0C"; // 警告(閾値参照線・警戒チップ)

type DeltaMode = "pct" | "pt";

/**
 * ソース優先チェーンの候補(§8 Phase 2「系列の重複期間は公式ソースを優先」のweb側実装)。
 * 先頭から順に評価し、データが存在する最初の候補を採用する。
 * 追加ソース(公式系)が未取得・取得失敗でもフォールバック候補でMVP部分は無傷。
 */
type SourceCandidate = {
  seriesId: string;
  transform?: "raw" | "yoy"; // 既定 raw。yoy = 前年同月比pt(表示層で計算、DB非保存)
  note?: string; // この候補を採用したときのみ表示する注記
  years?: number; // この候補を採用したときのチャート表示期間の上書き
};

type PanelDef = {
  key: string;
  title: string;
  kind: "chain" | "rate_diff";
  candidates?: SourceCandidate[]; // kind === "chain" で必須
  color: string;
  scale?: number; // 生値に掛ける係数(単位変換)
  prefix?: string;
  suffix?: string;
  decimals: number;
  years?: number; // チャート表示期間(年)。既定2年
  note?: string;
  deltaMode: DeltaMode;
  deltaUnit?: string; // pt モードの単位表記の上書き(例: "億円")
  deltaDecimals?: number; // 騰落表示の小数桁。既定2
  signed?: boolean; // 正値にも + を付ける(貿易収支など符号が意味を持つ系列)
  includeZero?: boolean; // チャートY軸ドメインに必ず0を含める(負値をまたぐ系列)
  showMoM?: boolean; // 既定 true
  showYoY?: boolean; // 既定 true
  chartType?: "line" | "bar"; // bar = 極性を持つ月次フロー(既定 line)
  warnAbove?: number; // 最新値がこの閾値以上で「警戒」チップを併記
  referenceLines?: ReferenceLineData[]; // 意味のある閾値の参照線のみ
  range52?: boolean; // 52週レンジバーを表示(水準系のみ。YoY系・B/S系は付けない)
};

// 参照線の共有定義(0線: 履歴に負値がある系列。罫線よりやや明るい実線)
const ZERO_LINE: ReferenceLineData[] = [{ y: 0, solid: true }];
const CPI_TARGET_LINE: ReferenceLineData[] = [{ y: 2, label: "2%目標" }];

// ---- ソース優先チェーン定義(複数箇所から参照するものは共有) --------------

/** 日CPI YoY: e-Stat月次(YoY計算)を優先、無ければFRED年次(値が既に前年比%) */
const JP_CPI_CHAIN: SourceCandidate[] = [
  { seriesId: "ESTAT:CPI_JP", transform: "yoy" },
  { seriesId: "FRED:FPCPITOTLZGJPN", note: "年次", years: 10 },
];

/** JGB10年: 財務省日次を優先、無ければFRED(OECD)月次 */
const JGB10Y_CHAIN: SourceCandidate[] = [
  { seriesId: "MOF:JGB10Y" },
  { seriesId: "FRED:IRLTLT01JPM156N" },
];

// §6.1 レイアウト: 4列グリッド(行順を維持)。6行目以降はPhase 2追加(日本・財政)
const PANEL_DEFS: PanelDef[] = [
  // 1行目: インフレ・金利
  { key: "us_cpi", title: "米CPI YoY", kind: "chain", candidates: [{ seriesId: "FRED:CPIAUCSL", transform: "yoy" }], color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt", referenceLines: CPI_TARGET_LINE },
  { key: "jp_cpi", title: "日CPI YoY", kind: "chain", candidates: JP_CPI_CHAIN, color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt", showMoM: false, referenceLines: CPI_TARGET_LINE },
  { key: "bei", title: "米10年BEI", kind: "chain", candidates: [{ seriesId: "FRED:T10YIE" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", range52: true },
  // 0線は付けない: 全履歴min=0.50%で負値が無く、extendDomainで0を含めると
  // 実データの変動がチャート上半分に圧縮される(負値圏に入ったら再導入)
  { key: "rate_diff", title: "日米金利差", kind: "rate_diff", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 2行目: 通貨・中銀
  { key: "usdjpy", title: "USD/JPY", kind: "chain", candidates: [{ seriesId: "FRED:DEXJPUS" }], color: GREEN, suffix: "円", decimals: 2, deltaMode: "pct", range52: true },
  { key: "dxy", title: "ドル指数", kind: "chain", candidates: [{ seriesId: "FRED:DTWEXBGS" }], color: GREEN, decimals: 2, deltaMode: "pct", range52: true },
  { key: "fed_bs", title: "Fed B/S", kind: "chain", candidates: [{ seriesId: "FRED:WALCL" }], color: GREEN, scale: 1 / 1_000_000, prefix: "$", suffix: "T", decimals: 2, deltaMode: "pct" },
  { key: "boj_bs", title: "日銀 B/S", kind: "chain", candidates: [{ seriesId: "FRED:JPNASSETS" }], color: GREEN, scale: 1 / 10_000, suffix: "兆円", decimals: 0, deltaMode: "pct" },
  // 3行目: 実物資産
  { key: "gold", title: "金", kind: "chain", candidates: [{ seriesId: "YF:GC=F" }], color: GREEN, prefix: "$", decimals: 1, deltaMode: "pct", range52: true },
  { key: "wti", title: "WTI原油", kind: "chain", candidates: [{ seriesId: "YF:CL=F" }], color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct", range52: true },
  { key: "copper", title: "銅", kind: "chain", candidates: [{ seriesId: "YF:HG=F" }], color: GREEN, prefix: "$", decimals: 3, deltaMode: "pct", range52: true },
  { key: "ust10", title: "米10年金利", kind: "chain", candidates: [{ seriesId: "FRED:DGS10" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", range52: true },
  // 4行目: 株式・リスク
  { key: "n225", title: "日経225", kind: "chain", candidates: [{ seriesId: "YF:^N225" }], color: GREEN, decimals: 0, deltaMode: "pct", range52: true },
  { key: "spx", title: "S&P500", kind: "chain", candidates: [{ seriesId: "YF:^GSPC" }], color: GREEN, decimals: 0, deltaMode: "pct", range52: true },
  { key: "vix", title: "VIX", kind: "chain", candidates: [{ seriesId: "YF:^VIX" }], color: BLUE, decimals: 2, deltaMode: "pct", range52: true, warnAbove: 30, referenceLines: [{ y: 30, label: "警戒", color: WARN }] },
  { key: "hy", title: "HYスプレッド", kind: "chain", candidates: [{ seriesId: "FRED:BAMLH0A0HYM2" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", range52: true, warnAbove: 4, referenceLines: [{ y: 4, label: "注意", color: WARN }] },
  // 5行目: 不動産・その他
  { key: "reit", title: "東証REIT", kind: "chain", candidates: [{ seriesId: "YF:1343.T" }], color: GREEN, suffix: "円", decimals: 0, deltaMode: "pct", range52: true },
  { key: "cs", title: "米住宅CS", kind: "chain", candidates: [{ seriesId: "FRED:CSUSHPISA" }], color: GREEN, decimals: 1, deltaMode: "pct", range52: true },
  { key: "real", title: "実質金利", kind: "chain", candidates: [{ seriesId: "FRED:DFII10" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", range52: true },
  { key: "natgas", title: "天然ガス", kind: "chain", candidates: [{ seriesId: "YF:NG=F" }], color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct", range52: true },
  // 6行目: 日本・財政(Phase 2)。30年金利は財政ドミナンス懸念のセンサー(§4.2)
  { key: "jgb30", title: "日本30年金利", kind: "chain", candidates: [{ seriesId: "MOF:JGB30Y" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", range52: true },
  { key: "callon", title: "無担保コールO/N", kind: "chain", candidates: [{ seriesId: "BOJ:CALLON" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt", referenceLines: ZERO_LINE },
  { key: "mb", title: "マネタリーベース", kind: "chain", candidates: [{ seriesId: "BOJ:MB" }], color: GREEN, scale: 1 / 10_000, suffix: "兆円", decimals: 0, deltaMode: "pct" },
  { key: "realwage", title: "実質賃金 YoY", kind: "chain", candidates: [{ seriesId: "ESTATDB:REALWAGE", transform: "yoy" }], color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt", showMoM: false, referenceLines: ZERO_LINE },
  // 7行目: 貿易(Phase 2)。負値ありのため符号付き・Y軸は0ラインを必ず含める
  { key: "trade", title: "貿易収支", kind: "chain", candidates: [{ seriesId: "CUSTOMS:TRADE" }], color: GREEN, suffix: "億円", decimals: 0, deltaMode: "pt", deltaUnit: "億円", deltaDecimals: 0, signed: true, includeZero: true, chartType: "bar" },
];

// ---- カテゴリ別セクション(表示グループ) ----------------------------------
// §6.1の注記「パネルの並び順は実装時に見やすさ優先で入れ替えてよい」に基づき、
// 25パネルを6カテゴリへ再編成して表示する。パネル定義(PANEL_DEFS)・データ処理は
// 変更せず、表示順のみここで定義する。全パネルが漏れなく重複なく属することは
// lib/panels.test.ts で検証する。

export type PanelGroup = { title: string; keys: string[] };

export const PANEL_GROUPS: PanelGroup[] = [
  { title: "インフレ・金利", keys: ["us_cpi", "jp_cpi", "bei", "ust10", "real", "rate_diff"] },
  { title: "通貨・中銀", keys: ["usdjpy", "dxy", "fed_bs", "boj_bs", "mb", "callon"] },
  { title: "実物資産", keys: ["gold", "wti", "copper", "natgas"] },
  { title: "株式・リスク", keys: ["n225", "spx", "vix", "hy"] },
  { title: "日本・財政", keys: ["jgb30", "realwage", "trade"] },
  { title: "不動産", keys: ["reit", "cs"] },
];

/** グループ整合性テスト用: 全パネルのkey一覧(定義順)。 */
export const PANEL_KEYS: string[] = PANEL_DEFS.map((d) => d.key);

const ALL_SERIES_IDS = [
  "FRED:CPIAUCSL",
  "FRED:FPCPITOTLZGJPN",
  "FRED:T10YIE",
  "FRED:DGS10",
  "FRED:IRLTLT01JPM156N",
  "FRED:DFII10",
  "FRED:DEXJPUS",
  "FRED:DTWEXBGS",
  "FRED:WALCL",
  "FRED:JPNASSETS",
  "FRED:BAMLH0A0HYM2",
  "FRED:CSUSHPISA",
  "YF:GC=F",
  "YF:CL=F",
  "YF:HG=F",
  "YF:NG=F",
  "YF:^N225",
  "YF:^GSPC",
  "YF:^VIX",
  "YF:1343.T",
  // Phase 2: 日本公式ソース
  "ESTAT:CPI_JP",
  "ESTATDB:REALWAGE",
  "MOF:JGB10Y",
  "MOF:JGB30Y",
  "BOJ:MB",
  "BOJ:CALLON",
  "CUSTOMS:TRADE",
];

// 日付ヘルパー(shiftMonths / lastOnOrBefore)と派生系列(computeYoY)は
// レジーム判定エンジンと共有のため lib/regime.ts に定義(単一実装)。

/**
 * ソース優先チェーンの解決: データが存在する最初の候補を採用する。
 * 全候補が空なら null(=取得待ち)。
 */
function resolveChain(
  candidates: SourceCandidate[],
  obsMap: Map<string, Observation[]>
): { obs: Observation[]; candidate: SourceCandidate } | null {
  for (const candidate of candidates) {
    const raw = obsMap.get(candidate.seriesId) ?? [];
    const obs = candidate.transform === "yoy" ? computeYoY(raw) : raw;
    if (obs.length > 0) return { obs, candidate };
  }
  return null;
}

/** 日米金利差: 各DGS10観測日に対し「その日以前で最新のJGB10年」を引いた差(%)。 */
function computeRateDiff(us: Observation[], jp: Observation[]): Observation[] {
  if (us.length === 0 || jp.length === 0) return [];
  const out: Observation[] = [];
  let idx = -1;
  for (const o of us) {
    while (idx + 1 < jp.length && jp[idx + 1].date <= o.date) idx++;
    if (idx >= 0) out.push({ date: o.date, value: o.value - jp[idx].value });
  }
  return out;
}

// ---- 整形 ------------------------------------------------------------------

function formatNumber(v: number, decimals: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function makeChange(
  latest: number,
  ref: number | null,
  mode: DeltaMode,
  unit?: string,
  decimals = 2
): ChangeData | null {
  if (ref === null) return null;
  let v: number;
  let suffix: string;
  if (mode === "pct") {
    if (ref === 0) return null;
    v = (latest / ref - 1) * 100;
    suffix = "%";
  } else {
    v = latest - ref;
    suffix = unit ?? "pt";
  }
  const dir: 1 | 0 | -1 = v > 0 ? 1 : v < 0 ? -1 : 0;
  return { text: `${v > 0 ? "+" : ""}${formatNumber(v, decimals)}${suffix}`, dir };
}

// ---- 52週レンジ(コクピットの位置計器) ------------------------------------

export type Range52 = { min: number; max: number; pos: number };

/**
 * 直近365日(最新観測日基準)の観測から min / max / 現在位置(0..1)を返す。
 * 純関数。観測が空なら null。窓内が単一値(min == max)のときは中央 0.5。
 */
export function range52w(obs: Observation[]): Range52 | null {
  if (obs.length === 0) return null;
  const latest = obs[obs.length - 1];
  const cutoffMs = Date.parse(latest.date) - 365 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(cutoffMs)) return null; // 不正日付でページを落とさない
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  let min = Infinity;
  let max = -Infinity;
  for (const o of obs) {
    if (o.date < cutoff) continue;
    if (o.value < min) min = o.value;
    if (o.value > max) max = o.value;
  }
  const pos = max === min ? 0.5 : (latest.value - min) / (max - min);
  return { min, max, pos };
}

// ---- パネル組み立て --------------------------------------------------------

function emptyPanel(def: PanelDef): PanelData {
  return {
    key: def.key,
    title: def.title,
    color: def.color,
    note: def.note,
    latest: null,
    latestDate: null,
    delta: null,
    mom: null,
    yoy: null,
    points: [],
    prefix: def.prefix ?? "",
    suffix: def.suffix ?? "",
    decimals: def.decimals,
    signed: def.signed ?? false,
    includeZero: def.includeZero ?? false,
    chartType: def.chartType ?? "line",
    warn: false,
    referenceLines: def.referenceLines ?? [],
    range52: null,
  };
}

function buildPanel(def: PanelDef, obsMap: Map<string, Observation[]>): PanelData {
  let obs: Observation[];
  let note = def.note;
  let years = def.years ?? 2;

  if (def.kind === "rate_diff") {
    const jgb = resolveChain(JGB10Y_CHAIN, obsMap);
    obs = computeRateDiff(obsMap.get("FRED:DGS10") ?? [], jgb?.obs ?? []);
  } else {
    const resolved = resolveChain(def.candidates ?? [], obsMap);
    if (!resolved) return emptyPanel(def);
    obs = resolved.obs;
    // 注記・表示期間は「採用された候補」のものを優先(例: 日CPIの年次フォールバック時のみ「(年次)」)
    note = resolved.candidate.note ?? def.note;
    years = resolved.candidate.years ?? def.years ?? 2;
  }

  if (def.scale !== undefined) {
    const s = def.scale;
    obs = obs.map((o) => ({ date: o.date, value: o.value * s }));
  }

  if (obs.length === 0) return emptyPanel(def);

  const latest = obs[obs.length - 1];
  const prev = obs.length >= 2 ? obs[obs.length - 2] : null;
  const momRef = lastOnOrBefore(obs, shiftMonths(latest.date, -1));
  const yoyRef = lastOnOrBefore(obs, shiftMonths(latest.date, -12));

  const cutoff = shiftMonths(latest.date, -12 * years);
  const points = obs.filter((o) => o.date >= cutoff);

  const sign = def.signed && latest.value > 0 ? "+" : "";
  const change = (ref: number | null) =>
    makeChange(latest.value, ref, def.deltaMode, def.deltaUnit, def.deltaDecimals);

  // 52週レンジバー(水準系のみ)。min/max はパネルと同じ桁数で整形
  let range52: PanelData["range52"] = null;
  if (def.range52) {
    const r = range52w(obs);
    if (r) {
      range52 = {
        pos: Math.min(1, Math.max(0, r.pos)),
        minText: formatNumber(r.min, def.decimals),
        maxText: formatNumber(r.max, def.decimals),
      } satisfies Range52Data;
    }
  }

  return {
    key: def.key,
    title: def.title,
    color: def.color,
    note,
    latest: `${def.prefix ?? ""}${sign}${formatNumber(latest.value, def.decimals)}${def.suffix ?? ""}`,
    latestDate: latest.date,
    delta: change(prev?.value ?? null),
    mom: def.showMoM === false ? null : change(momRef?.value ?? null),
    yoy: def.showYoY === false ? null : change(yoyRef?.value ?? null),
    points,
    prefix: def.prefix ?? "",
    suffix: def.suffix ?? "",
    decimals: def.decimals,
    signed: def.signed ?? false,
    includeZero: def.includeZero ?? false,
    chartType: def.chartType ?? "line",
    warn: def.warnAbove !== undefined && latest.value >= def.warnAbove,
    referenceLines: def.referenceLines ?? [],
    range52,
  };
}

// ---- レジーム・ストリップ(§6.3 / §8 Phase 3: ルールエンジン) --------------

/** 設定エラー時の退避表示に使うMVP相当の8セル(§6.3 のコア指標)。 */
const REGIME_FALLBACK_LABELS = [
  "米CPI",
  "日CPI",
  "JGB10Y",
  "USDJPY",
  "金",
  "Fed B/S",
  "日銀B/S",
  "VIX",
];

/** 判定ルールの単一の正: リポジトリ直下 config/regime.yaml(web/ の1つ上)。 */
function resolveRegimeConfigPath(): string {
  if (process.env.MACRO_REGIME_CONFIG) return process.env.MACRO_REGIME_CONFIG;
  return path.resolve(process.cwd(), "..", "config", "regime.yaml");
}

/**
 * regime.yaml の読み込み+検証。YAML欠如・パース失敗・スキーマ不正のいかなる
 * 場合も例外を外へ漏らさず null を返す(ページを絶対に落とさないため)。
 */
function loadRegimeConfig(): RegimeConfig | null {
  try {
    return parseRegimeConfig(fs.readFileSync(resolveRegimeConfigPath(), "utf-8"));
  } catch {
    return null;
  }
}

/** 設定エラー時の退避表示: 全セル中立グレー+「ルール設定エラー」小表示。 */
function regimeFallback(): RegimeStripData {
  return {
    cells: REGIME_FALLBACK_LABELS.map((label) => ({
      key: label,
      label,
      dir: "flat" as const,
      state: "neutral" as const,
      value: null,
      spark: [],
    })),
    summary: null,
    error: "ルール設定エラー",
  };
}

/**
 * レジームセルの最新値の整形(11px等幅のマイクロ表示用)。
 * 桁の大きい系列(B/S等の生値)はコンパクト表記に落として幅を守る。
 */
// レジームセルの単位整形: 生値のコンパクト表記だと B/S 系が「6.74M」等になり、
// 直下のパネルの「$6.74T」「640兆円」と同一量が桁違いに読めるため、
// パネル表示と桁を揃える(WALCL=百万ドル→兆ドル、JPNASSETS=億円→兆円)
const CELL_FORMATTERS: Record<string, (v: number) => string> = {
  "FRED:WALCL": (v) => `$${(v / 1_000_000).toFixed(2)}T`,
  "FRED:JPNASSETS": (v) => `${Math.round(v / 10_000)}兆円`,
};

function formatCellValue(v: number): string {
  const av = Math.abs(v);
  if (av >= 100_000) {
    return v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  }
  if (av >= 1_000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * セルの採用系列から「最新値(整形済み)+直近3ヶ月のスパークライン生値」を返す。
 * データ欠損時は value: null / spark: []。
 */
function cellGauge(
  series: RegimeConfig["cells"][number]["series"],
  obsMap: Map<string, Observation[]>
): { value: string | null; spark: number[] } {
  const obs = resolveSeriesChain(series, obsMap);
  if (obs.length === 0) return { value: null, spark: [] };
  // resolveSeriesChain と同じ規則で「採用された候補」を特定し、単位整形に使う
  const winner = series.find((ref) => {
    const raw = obsMap.get(ref.id) ?? [];
    return (ref.transform === "yoy" ? computeYoY(raw) : raw).length > 0;
  });
  const fmt = winner ? CELL_FORMATTERS[winner.id] : undefined;
  const latest = obs[obs.length - 1];
  const cutoff = shiftMonths(latest.date, -3);
  const spark = obs.filter((o) => o.date >= cutoff).map((o) => o.value);
  return { value: fmt ? fmt(latest.value) : formatCellValue(latest.value), spark };
}

// ---- エントリポイント ------------------------------------------------------

export function getDashboardData(): {
  updatedAt: string | null;
  fetchHealth: FetchHealth | null;
  panels: PanelData[];
  regime: RegimeStripData;
} {
  // ユーザーが regime.yaml に独自系列を書いても評価できるよう、
  // パネル定義と設定ファイルの系列IDの和集合を1接続でまとめて読む
  const config = loadRegimeConfig();
  const seriesIds = new Set(ALL_SERIES_IDS);
  if (config) {
    for (const cell of config.cells) {
      for (const ref of cell.series) seriesIds.add(ref.id);
    }
  }
  const obsMap = getObservationsMap([...seriesIds]);
  const panels = PANEL_DEFS.map((def) => buildPanel(def, obsMap));

  let regime: RegimeStripData;
  if (config) {
    const result = evaluateRegime(config, obsMap);
    // 評価結果セルと設定セルは同順(evaluateRegime は config.cells を map する)
    regime = {
      cells: result.cells.map((c, i) => ({
        key: c.key,
        label: c.label,
        dir: c.dir,
        state: c.state,
        ...cellGauge(config.cells[i].series, obsMap),
      })),
      summary: { text: result.summary.text, name: result.summary.name },
      error: null,
    };
  } else {
    regime = regimeFallback();
  }

  const ts = getLastFetchTs();
  let updatedAt: string | null = null;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      updatedAt =
        d.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }) + " JST";
    }
  }

  return { updatedAt, fetchHealth: getFetchHealth(), panels, regime };
}
