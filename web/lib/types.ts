export type ChangeData = { text: string; dir: 1 | 0 | -1 };

export type PanelData = {
  key: string;
  title: string;
  color: string;
  note?: string;
  latest: string | null; // 整形済み最新値。null = 取得待ち
  latestDate: string | null;
  delta: ChangeData | null; // ヘッダ右寄せの騰落率(直近観測比)
  mom: ChangeData | null; // 前月比
  yoy: ChangeData | null; // 前年比
  points: { date: string; value: number }[];
  prefix: string;
  suffix: string;
  decimals: number;
  signed: boolean; // 正値にも + を付ける(貿易収支など)
  includeZero: boolean; // チャートY軸に必ず0を含める(負値をまたぐ系列)
};

export type RegimeCellData = {
  key: string; // regime.yaml cells[].key(一意。React key に使う)
  label: string;
  dir: "up" | "down" | "flat"; // ▲▼(実際の方向)
  state: "aligned" | "contrary" | "neutral"; // 色(整合=緑/逆行=赤/中立=グレー)
};

export type RegimeSummaryData = {
  text: string; // 例: 「シナリオ継続 7/8」「要注意 4/8(逆行2)」
  name: string; // シナリオ名(ツールチップ表示用)
};

export type RegimeStripData = {
  cells: RegimeCellData[];
  summary: RegimeSummaryData | null; // 設定エラー時は null
  error: string | null; // 設定エラー時の小表示(例: 「ルール設定エラー」)
};
