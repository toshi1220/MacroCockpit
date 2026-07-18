# Macro Cockpit

日本と世界のマクロ経済を一画面で監視する個人用ダッシュボード。
FRED / Yahoo Finance / IB(TWS・IB Gateway)の時系列を日次バッチで SQLite に蓄積し、Next.js で表示する。
詳細な仕様は [SPEC.md](./SPEC.md)、実装フェーズと受け入れ基準は SPEC §8 を参照。

現在の実装状況: **Phase 1(MVP)完了 + Phase 2A(IB一次ソース化)**。全21系列を取得し、Next.js ダッシュボード(20パネル+レジーム・ストリップ静的版)で表示する。先物4系列とFX補助系列の一次ソースは IB(SPEC §4.4)で、IB が使えないときは自動で yfinance にフォールバックする。

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
# IB を一次ソースにする場合は IB_HOST / IB_PORT / IB_CLIENT_ID も設定
# (未設定・接続不可でも yfinance フォールバックで全系列取得できる)
```

### 3. 初期化・取得・テスト

```sh
make init    # uv sync + npm install + DBスキーマ初期化 (data/macro.sqlite)
make fetch   # 全系列を取得し SQLite へ UPSERT
make test    # pytest(ネットワーク不要)
make dev     # ダッシュボード開発サーバ (http://localhost:3000)
```

`make fetch` は冪等(UPSERT)なので、何度実行しても observations の行数は増えない。
取得結果は `fetch_log` テーブルに記録される。DB パスは環境変数 `MACRO_DB_PATH` で上書きできる。
yfinance はレート制限で一部系列が一時的に失敗することがある。その場合は少し待って `make fetch` を再実行すればよい(失敗系列だけが `fetch_log` に `error` として残り、他系列とページ全体は無傷)。

## 系列表(Phase 1・確定版 — この表が系列定義の正)

系列定義の単一の正は [`fetcher/src/fetcher/registry.py`](./fetcher/src/fetcher/registry.py)。
SPEC §4.1 の「要確認」系列は FRED API で実在検証済み。実在しない系列は代替に差し替えてある(下記注記)。**以下の21行がこのプロジェクトの系列定義の正である。**

| # | series_id | ソース | ソースID | 指標 | 単位 | 頻度 |
|---|---|---|---|---|---|---|
| 1 | `FRED:CPIAUCSL` | FRED | CPIAUCSL | 米CPI | 指数 | M |
| 2 | `FRED:FPCPITOTLZGJPN` | FRED | FPCPITOTLZGJPN | 日本CPI(年次) | % | A |
| 3 | `FRED:T10YIE` | FRED | T10YIE | 米10年BEI | % | D |
| 4 | `FRED:DGS10` | FRED | DGS10 | 米10年金利 | % | D |
| 5 | `FRED:IRLTLT01JPM156N` | FRED | IRLTLT01JPM156N | 日本10年金利 | % | M |
| 6 | `FRED:DFII10` | FRED | DFII10 | 米10年実質金利 | % | D |
| 7 | `FRED:DEXJPUS` | FRED | DEXJPUS | USD/JPY | 円 | D |
| 8 | `FRED:DTWEXBGS` | FRED | DTWEXBGS | ドル実効指数 | 指数 | D |
| 9 | `FRED:WALCL` | FRED | WALCL | Fed総資産 | 百万ドル | W |
| 10 | `FRED:JPNASSETS` | FRED | JPNASSETS | 日銀総資産 | 億円 | M |
| 11 | `FRED:BAMLH0A0HYM2` | FRED | BAMLH0A0HYM2 | 米HY社債スプレッド | % | D |
| 12 | `FRED:CSUSHPISA` | FRED | CSUSHPISA | 米住宅価格CS | 指数 | M |
| 13 | `YF:GC=F` | IB(FB: Yahoo `GC=F`) | ContFuture:GC:COMEX | 金先物 | USD | D |
| 14 | `YF:CL=F` | IB(FB: Yahoo `CL=F`) | ContFuture:CL:NYMEX | WTI原油 | USD | D |
| 15 | `YF:HG=F` | IB(FB: Yahoo `HG=F`) | ContFuture:HG:COMEX | 銅先物 | USD | D |
| 16 | `YF:NG=F` | IB(FB: Yahoo `NG=F`) | ContFuture:NG:NYMEX | 天然ガス | USD | D |
| 17 | `YF:^N225` | Yahoo | ^N225 | 日経225 | pt | D |
| 18 | `YF:^GSPC` | Yahoo | ^GSPC | S&P500 | pt | D |
| 19 | `YF:^VIX` | Yahoo | ^VIX | VIX | pt | D |
| 20 | `YF:1343.T` | Yahoo | 1343.T | 東証REIT | 円 | D |
| 21 | `YF:JPY=X` | IB(FB: Yahoo `JPY=X`) | Forex:USDJPY | USD/JPY(補助) | 円 | D |

頻度は `D`(日次)/ `W`(週次)/ `M`(月次)/ `A`(年次)。「FB」はフォールバック。

### Phase 2A: IB 一次ソース化(SPEC §4.4)の注記

- **#13〜#16・#21 の一次ソースは IB**(先物は ContFuture の日足 TRADES、USDJPY は IDEALPRO の MIDPOINT、直近1年分)。IB セッション確立や個別取得に失敗すると自動で yfinance にフォールバックし、`fetch_log` の message に使用ソース(`via ib` / `via yahoo (ib ... failed: ...)`)が残る。系列の重複期間は IB を優先する(IB の値は INSERT OR REPLACE で最新化し、フォールバック yfinance の値は INSERT OR IGNORE で未収録日だけを埋める。IB 障害日にフォールバックが走っても蓄積済みの IB 値は上書きされない)。
- **series_id は `YF:` 接頭辞のまま据え置き。** 蓄積済み observations との継続性のため series_id は変更しない(接頭辞が旧ソース名なのは歴史的経緯)。DB の `series.source` は `'ib'` になる。
- **取引システムと同居するためのガードレール(SPEC §4.4)**: 取得は専用 clientId(`IB_CLIENT_ID`、既定 97)のワンショット接続(取得後即切断・readonly)で行い、`sources/ib.py` には発注系のコードを一切書かない(テストで機械的に検証)。IB へのリトライは一切せず、失敗は即 yfinance フォールバックに切り替える。

### 確定版に至った注記(SPEC §4.1 からの変更点)

- **日本CPI: `JPNCPIALLMINMEI`(SPEC 記載)→ `FPCPITOTLZGJPN`(年次)に差し替え。**
  SPEC の日本CPI系列 `JPNCPIALLMINMEI`(OECD系列)は 2021-06 で更新停止・廃止済みで、FRED 上に生きた**月次**の日本CPIは存在しない。代替として世界銀行の
  「Inflation, consumer prices for Japan」= `FPCPITOTLZGJPN`(**年次・前年比%**・2025年まで更新中)を採用した。
  そのため頻度 `A`(年次)は SPEC のスキーマコメント(`D`|`W`|`M`)の拡張だが、本系列のために許容する。
  月次の日本CPIは Phase 2 で e-Stat API から取得する予定(SPEC §4.2)。
- **`DTWEXBGS`(ドル実効指数)の実頻度は日次(D)。** SPEC §4.1 では週次と記載されているが、FRED のシリーズメタデータ(`frequency_short`)は `Daily` であり、実データも日次のため `D` とした。
- **`YF:JPY=X` は補助系列。** USD/JPY の正は FRED の `DEXJPUS`(#7)。#21 は日次の補助・クロスチェック用として併設する(SPEC §4.1 通貨欄の「補助として yfinance `JPY=X`」。Phase 2A で一次ソースは IB の IDEALPRO ミッドに切り替え、yfinance はフォールバック)。
- 上記以外の「要確認」系列(`IRLTLT01JPM156N` 日本10年金利・月次、`JPNASSETS` 日銀総資産・月次)は FRED API で 2026-06 まで更新中であることを確認し、そのまま採用した。

拡張・変更は `registry.py` の `SERIES` へのエントリ追加/修正のみで行う(定義の単一化)。
