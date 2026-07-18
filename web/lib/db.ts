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

/** fetch_log の status='ok' の最大 ts(ISO文字列)。無ければ null。 */
export function getLastFetchTs(): string | null {
  return withDb((db) => {
    const row = db
      .prepare("SELECT MAX(ts) AS ts FROM fetch_log WHERE status = 'ok'")
      .get() as { ts: string | null } | undefined;
    return row?.ts ?? null;
  }, null);
}
