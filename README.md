# Macro Cockpit

日本と世界のマクロ経済を一画面で監視する個人用ダッシュボード。
FRED / Yahoo Finance の時系列を日次バッチで SQLite に蓄積し、Next.js で表示する(表示層は Phase 1)。
詳細な仕様は [SPEC.md](./SPEC.md)、実装フェーズと受け入れ基準は SPEC §8 を参照。

現在の実装状況: **Phase 0(骨格)**。FRED から DGS10 の1系列のみ取得する。

## セットアップ

### 1. uv の導入

Python 環境は [uv](https://docs.astral.sh/uv/) で管理する(system の python は不要)。

```sh
# uv 未導入なら
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

### 2. .env の用意

FRED の無料 API キー(https://fred.stlouisfed.org/docs/api/api_key.html)を設定する。

```sh
cp .env.example .env
# .env を編集して FRED_API_KEY=... を設定
```

### 3. 初期化・取得・テスト

```sh
make init    # uv sync + DBスキーマ初期化 (data/macro.sqlite)
make fetch   # 全系列を取得し SQLite へ UPSERT
make test    # pytest(ネットワーク不要)
make dev     # 開発サーバ(web/ は Phase 1 のため現状は案内メッセージのみ)
```

`make fetch` は冪等(UPSERT)なので、何度実行しても observations の行数は増えない。
取得結果は `fetch_log` テーブルに記録される。DB パスは環境変数 `MACRO_DB_PATH` で上書きできる。

## 系列表(Phase 0 時点)

系列定義の単一の正は [`fetcher/src/fetcher/registry.py`](./fetcher/src/fetcher/registry.py)。

| series_id | ソース | ソースID | 指標 | 単位 | 頻度 |
|---|---|---|---|---|---|
| `FRED:DGS10` | FRED | DGS10 | 米10年金利 | % | 日次 |

Phase 1 で SPEC §4.1 の全系列(米日 CPI、BEI、USD/JPY、金・原油・銅、日経225・S&P500・VIX ほか)に拡張予定。
拡張は registry.py へのエントリ追加のみで行う。
