import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Observation = { date: string; value: number };

/**
 * DBパスの解決: MACRO_DB_PATH があればそれ、無ければリポジトリ直下の
 * data/macro.sqlite(web/ の1つ上)を使う。
 */
function resolveDbPath(): string {
  if (process.env.MACRO_DB_PATH) return process.env.MACRO_DB_PATH;
  return path.resolve(process.cwd(), "..", "data", "macro.sqlite");
}

/**
 * DBを読み取り専用で開いて fn を実行する。
 * DBファイルが無い・テーブルが無い・壊れている等、いかなる場合も例外を
 * 外へ漏らさず fallback を返す(ページを絶対に落とさないため)。
 */
function withDb<T>(fn: (db: Database.Database) => T, fallback: T): T {
  const dbPath = resolveDbPath();
  let db: Database.Database | null = null;
  try {
    if (!fs.existsSync(dbPath)) return fallback;
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/**
 * 複数系列の観測値を1接続でまとめて取得する。
 * 存在しない系列・テーブル欠如などは空配列として返る。
 */
export function getObservationsMap(
  seriesIds: string[]
): Map<string, Observation[]> {
  const empty = new Map<string, Observation[]>(
    seriesIds.map((id) => [id, [] as Observation[]])
  );
  return withDb((db) => {
    const out = new Map<string, Observation[]>();
    const stmt = db.prepare(
      "SELECT date, value FROM observations WHERE series_id = ? AND value IS NOT NULL ORDER BY date ASC"
    );
    for (const id of seriesIds) {
      try {
        out.set(id, stmt.all(id) as Observation[]);
      } catch {
        out.set(id, []);
      }
    }
    return out;
  }, empty);
}

export type FetchHealth = { ok: number; error: number; total: number };

/**
 * 最新fetchバッチ(最大ts近傍30分)の系列別 ok/error 集計。
 * ts は '+00:00' 付きISOのため日時比較はJS側で行う(SQLiteのdatetime()と
 * 文字列比較すると 'T' 区切りの行が全件マッチする罠がある)。
 * 同一系列が同バッチに複数回現れた場合は最新の1行のみ数える。
 */
export function getFetchHealth(): FetchHealth | null {
  return withDb((db) => {
    const rows = db
      .prepare(
        "SELECT ts, series_id, status FROM fetch_log ORDER BY ts DESC LIMIT 500"
      )
      .all() as { ts: string; series_id: string; status: string }[];
    if (rows.length === 0) return null;
    const maxT = new Date(rows[0].ts).getTime();
    if (Number.isNaN(maxT)) return null;
    const WINDOW_MS = 30 * 60 * 1000;
    const latestBySeries = new Map<string, string>();
    for (const r of rows) {
      const t = new Date(r.ts).getTime();
      if (Number.isNaN(t) || maxT - t > WINDOW_MS) continue;
      // rows は ts 降順なので最初に出会った行がその系列の最新
      if (!latestBySeries.has(r.series_id)) latestBySeries.set(r.series_id, r.status);
    }
    let ok = 0;
    for (const status of latestBySeries.values()) {
      if (status === "ok") ok++;
    }
    // 分母は fetch_log 全体の既知系列数。最新バッチの窓(30分)から漏れた系列も
    // 分母に残るため、部分バッチ(途中killや30分超のrun)が「n/28 ok」の
    // n < 28 として可視化される(窓内だけを母数にすると欠落が隠れる)
    const totalRow = db
      .prepare("SELECT COUNT(DISTINCT series_id) AS n FROM fetch_log")
      .get() as { n: number } | undefined;
    const total = totalRow?.n ?? 0;
    const error = Math.max(0, total - ok);
    return total > 0 ? { ok, error, total } : null;
  }, null);
}

/** fetch_log の status='ok' の最大 ts(ISO文字列)。無ければ null。 */
export function getLastFetchTs(): string | null {
  return withDb((db) => {
    const row = db
      .prepare("SELECT MAX(ts) AS ts FROM fetch_log WHERE status = 'ok'")
      .get() as { ts: string | null } | undefined;
    return row?.ts ?? null;
  }, null);
}
