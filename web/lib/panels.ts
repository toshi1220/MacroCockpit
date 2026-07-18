import { getLastFetchTs, getObservationsMap, type Observation } from "./db";
import type { ChangeData, PanelData, RegimeCellData } from "./types";

const GREEN = "#73BF69"; // 主系列(価格・指数・B/S系)
const BLUE = "#5794F2"; // 金利・リスク系

type DeltaMode = "pct" | "pt";

type PanelDef = {
  key: string;
  title: string;
  kind: "raw" | "us_cpi_yoy" | "jp_cpi_yoy" | "rate_diff";
  seriesId?: string;
  color: string;
  scale?: number; // 生値に掛ける係数(単位変換)
  prefix?: string;
  suffix?: string;
  decimals: number;
  years?: number; // チャート表示期間(年)。既定2年
  note?: string;
  deltaMode: DeltaMode;
  showMoM?: boolean; // 既定 true
  showYoY?: boolean; // 既定 true
};

// §6.1 レイアウト: 5行×4列(行順を維持)
const PANEL_DEFS: PanelDef[] = [
  // 1行目: インフレ・金利
  { key: "us_cpi", title: "米CPI YoY", kind: "us_cpi_yoy", seriesId: "FRED:CPIAUCSL", color: GREEN, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "jp_cpi", title: "日CPI YoY", kind: "jp_cpi_yoy", seriesId: "FRED:FPCPITOTLZGJPN", color: GREEN, suffix: "%", decimals: 2, years: 10, note: "年次", deltaMode: "pt", showMoM: false },
  { key: "bei", title: "米10年BEI", kind: "raw", seriesId: "FRED:T10YIE", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "rate_diff", title: "日米金利差", kind: "rate_diff", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 2行目: 通貨・中銀
  { key: "usdjpy", title: "USD/JPY", kind: "raw", seriesId: "FRED:DEXJPUS", color: GREEN, suffix: "円", decimals: 2, deltaMode: "pct" },
  { key: "dxy", title: "ドル指数", kind: "raw", seriesId: "FRED:DTWEXBGS", color: GREEN, decimals: 2, deltaMode: "pct" },
  { key: "fed_bs", title: "Fed B/S", kind: "raw", seriesId: "FRED:WALCL", color: GREEN, scale: 1 / 1_000_000, prefix: "$", suffix: "T", decimals: 2, deltaMode: "pct" },
  { key: "boj_bs", title: "日銀 B/S", kind: "raw", seriesId: "FRED:JPNASSETS", color: GREEN, scale: 1 / 10_000, suffix: "兆円", decimals: 0, deltaMode: "pct" },
  // 3行目: 実物資産
  { key: "gold", title: "金", kind: "raw", seriesId: "YF:GC=F", color: GREEN, prefix: "$", decimals: 1, deltaMode: "pct" },
  { key: "wti", title: "WTI原油", kind: "raw", seriesId: "YF:CL=F", color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct" },
  { key: "copper", title: "銅", kind: "raw", seriesId: "YF:HG=F", color: GREEN, prefix: "$", decimals: 3, deltaMode: "pct" },
  { key: "ust10", title: "米10年金利", kind: "raw", seriesId: "FRED:DGS10", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 4行目: 株式・リスク
  { key: "n225", title: "日経225", kind: "raw", seriesId: "YF:^N225", color: GREEN, decimals: 0, deltaMode: "pct" },
  { key: "spx", title: "S&P500", kind: "raw", seriesId: "YF:^GSPC", color: GREEN, decimals: 0, deltaMode: "pct" },
  { key: "vix", title: "VIX", kind: "raw", seriesId: "YF:^VIX", color: BLUE, decimals: 2, deltaMode: "pct" },
  { key: "hy", title: "HYスプレッド", kind: "raw", seriesId: "FRED:BAMLH0A0HYM2", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  // 5行目: 不動産・その他
  { key: "reit", title: "東証REIT", kind: "raw", seriesId: "YF:1343.T", color: GREEN, suffix: "円", decimals: 0, deltaMode: "pct" },
  { key: "cs", title: "米住宅CS", kind: "raw", seriesId: "FRED:CSUSHPISA", color: GREEN, decimals: 1, deltaMode: "pct" },
  { key: "real", title: "実質金利", kind: "raw", seriesId: "FRED:DFII10", color: BLUE, suffix: "%", decimals: 2, deltaMode: "pt" },
  { key: "natgas", title: "天然ガス", kind: "raw", seriesId: "YF:NG=F", color: GREEN, prefix: "$", decimals: 2, deltaMode: "pct" },
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
];

// ---- 日付ヘルパー ----------------------------------------------------------

function shiftMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, daysInMonth);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** date 以前で最も近い観測を二分探索で返す。 */
function lastOnOrBefore(obs: Observation[], date: string): Observation | null {
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

// ---- 派生系列(DBには保存しない・表示層で計算) ----------------------------

/** 米CPI YoY: CPIAUCSL の前年同月比%(FRED月次は各月1日付なので同日一致で引ける)。 */
function computeUsCpiYoy(obs: Observation[]): Observation[] {
  const byDate = new Map(obs.map((o) => [o.date, o.value]));
  const out: Observation[] = [];
  for (const o of obs) {
    const prev = byDate.get(shiftMonths(o.date, -12));
    if (prev !== undefined && prev !== 0) {
      out.push({ date: o.date, value: (o.value / prev - 1) * 100 });
    }
  }
  return out;
}

/** 日米金利差: 各DGS10観測日に対し「その日以前で最新のJGB10年(月次)」を引いた差(%)。 */
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
  mode: DeltaMode
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
    suffix = "pt";
  }
  const dir: 1 | 0 | -1 = v > 0 ? 1 : v < 0 ? -1 : 0;
  return { text: `${v > 0 ? "+" : ""}${v.toFixed(2)}${suffix}`, dir };
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
  };
}

function buildPanel(def: PanelDef, obsMap: Map<string, Observation[]>): PanelData {
  let obs: Observation[];
  switch (def.kind) {
    case "us_cpi_yoy":
      obs = computeUsCpiYoy(obsMap.get("FRED:CPIAUCSL") ?? []);
      break;
    case "jp_cpi_yoy":
      obs = obsMap.get("FRED:FPCPITOTLZGJPN") ?? []; // 値が既に前年比%
      break;
    case "rate_diff":
      obs = computeRateDiff(
        obsMap.get("FRED:DGS10") ?? [],
        obsMap.get("FRED:IRLTLT01JPM156N") ?? []
      );
      break;
    default:
      obs = obsMap.get(def.seriesId ?? "") ?? [];
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

  const years = def.years ?? 2;
  const cutoff = shiftMonths(latest.date, -12 * years);
  const points = obs.filter((o) => o.date >= cutoff);

  return {
    key: def.key,
    title: def.title,
    color: def.color,
    note: def.note,
    latest: `${def.prefix ?? ""}${formatNumber(latest.value, def.decimals)}${def.suffix ?? ""}`,
    latestDate: latest.date,
    delta: makeChange(latest.value, prev?.value ?? null, def.deltaMode),
    mom:
      def.showMoM === false
        ? null
        : makeChange(latest.value, momRef?.value ?? null, def.deltaMode),
    yoy:
      def.showYoY === false
        ? null
        : makeChange(latest.value, yoyRef?.value ?? null, def.deltaMode),
    points,
    prefix: def.prefix ?? "",
    suffix: def.suffix ?? "",
    decimals: def.decimals,
  };
}

// ---- レジーム・ストリップ(§6.3 MVP: 静的表示のみ) ------------------------

function regimeCell(label: string, obs: Observation[]): RegimeCellData {
  if (obs.length === 0) return { label, dir: "flat" };
  const latest = obs[obs.length - 1];
  const ref = lastOnOrBefore(obs, shiftMonths(latest.date, -3));
  if (!ref) return { label, dir: "flat" };
  // 比率(latest/ref - 1)は基準値が負のとき符号が反転する(JGBマイナス金利期・
  // 日CPIデフレ期に実データあり)ため、符号付き差分で判定する
  const diff = latest.value - ref.value;
  const flatEps = 0.001 * Math.max(Math.abs(ref.value), 1); // 価格系は±0.1%、ゼロ近傍の金利系は±0.001pt
  if (Math.abs(diff) < flatEps) return { label, dir: "flat" };
  return { label, dir: diff > 0 ? "up" : "down" };
}

// ---- エントリポイント ------------------------------------------------------

export function getDashboardData(): {
  updatedAt: string | null;
  panels: PanelData[];
  regime: RegimeCellData[];
} {
  const obsMap = getObservationsMap(ALL_SERIES_IDS);
  const panels = PANEL_DEFS.map((def) => buildPanel(def, obsMap));

  const regime: RegimeCellData[] = [
    regimeCell("米CPI", computeUsCpiYoy(obsMap.get("FRED:CPIAUCSL") ?? [])),
    regimeCell("日CPI", obsMap.get("FRED:FPCPITOTLZGJPN") ?? []),
    regimeCell("JGB10Y", obsMap.get("FRED:IRLTLT01JPM156N") ?? []),
    regimeCell("USDJPY", obsMap.get("FRED:DEXJPUS") ?? []),
    regimeCell("金", obsMap.get("YF:GC=F") ?? []),
    regimeCell("Fed B/S", obsMap.get("FRED:WALCL") ?? []),
    regimeCell("日銀B/S", obsMap.get("FRED:JPNASSETS") ?? []),
    regimeCell("VIX", obsMap.get("YF:^VIX") ?? []),
  ];

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
