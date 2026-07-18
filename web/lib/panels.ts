import fs from "node:fs";
import path from "node:path";
import { getLastFetchTs, getObservationsMap, type Observation } from "./db";
import {
  computeYoY,
  evaluateRegime,
  lastOnOrBefore,
  parseRegimeConfig,
  shiftMonths,
  type RegimeConfig,
} from "./regime";
import type { ChangeData, PanelData, RegimeStripData } from "./types";

const GREEN = "#73BF69"; // 主系列(価格・指数・B/S系)
const BLUE = "#5794F2"; // 金利・リスク系

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
};

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
  { key: "us_cpi", title: "米CPI YoY", kind: "chain", candidates: [{ seriesId: "FRED:CPIAUCSL", transform: "yoy" }], color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "jp_cpi", title: "日CPI YoY", kind: "chain", candidates: JP_CPI_CHAIN, color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt", showMoM: false },
  { key: "bei", title: "米10年BEI", kind: "chain", candidates: [{ seriesId: "FRED:T10YIE" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "rate_diff", title: "日米金利差", kind: "rate_diff", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 2行目: 通貨・中銀
  { key: "usdjpy", title: "USD/JPY", kind: "chain", candidates: [{ seriesId: "FRED:DEXJPUS" }], color: GREEN, suffix: "円", decimals: 2, deltaMode: "pct" },
  { key: "dxy", title: "ドル指数", kind: "chain", candidates: [{ seriesId: "FRED:DTWEXBGS" }], color: GREEN, decimals: 2, deltaMode: "pct" },
  { key: "fed_bs", title: "Fed B/S", kind: "chain", candidates: [{ seriesId: "FRED:WALCL" }], color: GREEN, scale: 1 / 1_000_000, prefix: "$", suffix: "T", decimals: 2, deltaMode: "pct" },
  { key: "boj_bs", title: "日銀 B/S", kind: "chain", candidates: [{ seriesId: "FRED:JPNASSETS" }], color: GREEN, scale: 1 / 10_000, suffix: "兆円", decimals: 0, deltaMode: "pct" },
  // 3行目: 実物資産
  { key: "gold", title: "金", kind: "chain", candidates: [{ seriesId: "YF:GC=F" }], color: GREEN, prefix: "$", decimals: 1, deltaMode: "pct" },
  { key: "wti", title: "WTI原油", kind: "chain", candidates: [{ seriesId: "YF:CL=F" }], color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct" },
  { key: "copper", title: "銅", kind: "chain", candidates: [{ seriesId: "YF:HG=F" }], color: GREEN, prefix: "$", decimals: 3, deltaMode: "pct" },
  { key: "ust10", title: "米10年金利", kind: "chain", candidates: [{ seriesId: "FRED:DGS10" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 4行目: 株式・リスク
  { key: "n225", title: "日経225", kind: "chain", candidates: [{ seriesId: "YF:^N225" }], color: GREEN, decimals: 0, deltaMode: "pct" },
  { key: "spx", title: "S&P500", kind: "chain", candidates: [{ seriesId: "YF:^GSPC" }], color: GREEN, decimals: 0, deltaMode: "pct" },
  { key: "vix", title: "VIX", kind: "chain", candidates: [{ seriesId: "YF:^VIX" }], color: BLUE, decimals: 2, deltaMode: "pct" },
  { key: "hy", title: "HYスプレッド", kind: "chain", candidates: [{ seriesId: "FRED:BAMLH0A0HYM2" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 5行目: 不動産・その他
  { key: "reit", title: "東証REIT", kind: "chain", candidates: [{ seriesId: "YF:1343.T" }], color: GREEN, suffix: "円", decimals: 0, deltaMode: "pct" },
  { key: "cs", title: "米住宅CS", kind: "chain", candidates: [{ seriesId: "FRED:CSUSHPISA" }], color: GREEN, decimals: 1, deltaMode: "pct" },
  { key: "real", title: "実質金利", kind: "chain", candidates: [{ seriesId: "FRED:DFII10" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "natgas", title: "天然ガス", kind: "chain", candidates: [{ seriesId: "YF:NG=F" }], color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct" },
  // 6行目: 日本・財政(Phase 2)。30年金利は財政ドミナンス懸念のセンサー(§4.2)
  { key: "jgb30", title: "日本30年金利", kind: "chain", candidates: [{ seriesId: "MOF:JGB30Y" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "callon", title: "無担保コールO/N", kind: "chain", candidates: [{ seriesId: "BOJ:CALLON" }], color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "mb", title: "マネタリーベース", kind: "chain", candidates: [{ seriesId: "BOJ:MB" }], color: GREEN, scale: 1 / 10_000, suffix: "兆円", decimals: 0, deltaMode: "pct" },
  { key: "realwage", title: "実質賃金 YoY", kind: "chain", candidates: [{ seriesId: "ESTATDB:REALWAGE", transform: "yoy" }], color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt", showMoM: false },
  // 7行目: 貿易(Phase 2)。負値ありのため符号付き・Y軸は0ラインを必ず含める
  { key: "trade", title: "貿易収支", kind: "chain", candidates: [{ seriesId: "CUSTOMS:TRADE" }], color: GREEN, suffix: "億円", decimals: 0, deltaMode: "pt", deltaUnit: "億円", deltaDecimals: 0, signed: true, includeZero: true },
];

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
    })),
    summary: null,
    error: "ルール設定エラー",
  };
}

// ---- エントリポイント ------------------------------------------------------

export function getDashboardData(): {
  updatedAt: string | null;
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
    regime = {
      cells: result.cells.map((c) => ({ key: c.key, label: c.label, dir: c.dir, state: c.state })),
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

  return { updatedAt, panels, regime };
}
