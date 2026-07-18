# Macro Cockpit

日本と世界のマクロ経済を一画面で監視する個人用ダッシュボード。
FRED / Yahoo Finance / IB(TWS・IB Gateway)/ 日本公式ソース(e-Stat・統計ダッシュボード・財務省・日銀・税関)の時系列を日次バッチで SQLite に蓄積し、Next.js で表示する。
詳細な仕様は [SPEC.md](./SPEC.md)、実装フェーズと受け入れ基準は SPEC §8 を参照。

現在の実装状況: **Phase 1(MVP)完了 + Phase 2A(IB一次ソース化)+ Phase 2B(日本公式データ取得層)+ Phase 3(レジーム判定ルールエンジン)**。全28系列を取得し、Next.js ダッシュボードで表示する。先物4系列とFX補助系列の一次ソースは IB(SPEC §4.4)で、IB が使えないときは自動で yfinance にフォールバックする。Phase 2B で日本CPI(月次)・実質賃金・JGB10年/30年(日次)・マネタリーベース・無担保コールO/N・貿易収支の7系列を日本公式ソースから追加した。

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
# 日本CPI(月次)を取得するなら e-Stat の無料 appId を ESTAT_APP_ID=... に設定
#   (https://www.e-stat.go.jp/api/。他の日本公式ソースは appId 不要)
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

## 系列表(Phase 1 + 2A + 2B・確定版 — この表が系列定義の正)

系列定義の単一の正は [`fetcher/src/fetcher/registry.py`](./fetcher/src/fetcher/registry.py)。
SPEC §4.1 の「要確認」系列は FRED API で実在検証済み。実在しない系列は代替に差し替えてある(下記注記)。**以下の28行がこのプロジェクトの系列定義の正である。**

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
| 22 | `ESTAT:CPI_JP` | e-Stat API | 0003427113:1:0001:00000 | 日本CPI(月次) | 指数 | M |
| 23 | `ESTATDB:REALWAGE` | 統計ダッシュボードAPI | 0302030201010090010 | 実質賃金指数 | 指数 | M |
| 24 | `MOF:JGB10Y` | 財務省 CSV | jgb:10 | 日本10年金利(日次) | % | D |
| 25 | `MOF:JGB30Y` | 財務省 CSV | jgb:30 | 日本30年金利 | % | D |
| 26 | `BOJ:MB` | 日銀 stat-search CSV | md01_m_1:MD01'MABS1AN11 | マネタリーベース | 億円 | M |
| 27 | `BOJ:CALLON` | 日銀 stat-search CSV | fm01_d_1:FM01'STRDCLUCON | 無担保コールO/N | % | D |
| 28 | `CUSTOMS:TRADE` | 税関 貿易統計 CSV | d41ma | 貿易収支 | 億円 | M |

頻度は `D`(日次)/ `W`(週次)/ `M`(月次)/ `A`(年次)。「FB」はフォールバック。
#22〜#28(Phase 2B)は日本公式ソースが一次でフォールバックを持たない。取得失敗は `fetch_log` に `error` を記録して他系列の取得を継続する(web 側でパネル単位の代替表示を行う)。

### Phase 2A: IB 一次ソース化(SPEC §4.4)の注記

- **#13〜#16・#21 の一次ソースは IB**(先物は ContFuture の日足 TRADES、USDJPY は IDEALPRO の MIDPOINT、直近1年分)。IB セッション確立や個別取得に失敗すると自動で yfinance にフォールバックし、`fetch_log` の message に使用ソース(`via ib` / `via yahoo (ib ... failed: ...)`)が残る。系列の重複期間は IB を優先する(IB の値は INSERT OR REPLACE で最新化し、フォールバック yfinance の値は INSERT OR IGNORE で未収録日だけを埋める。IB 障害日にフォールバックが走っても蓄積済みの IB 値は上書きされない)。
- **series_id は `YF:` 接頭辞のまま据え置き。** 蓄積済み observations との継続性のため series_id は変更しない(接頭辞が旧ソース名なのは歴史的経緯)。DB の `series.source` は `'ib'` になる。
- **取引システムと同居するためのガードレール(SPEC §4.4)**: 取得は専用 clientId(`IB_CLIENT_ID`、既定 97)のワンショット接続(取得後即切断・readonly)で行い、`sources/ib.py` には発注系のコードを一切書かない(テストで機械的に検証)。IB へのリトライは一切せず、失敗は即 yfinance フォールバックに切り替える。

### Phase 2B: 日本公式ソース取得層(SPEC §4.2 / §8)の注記

実地調査(2026-07-19 実証)に基づき、各系列の一次ソースを次の通り確定した。取得層(`sources/`)は既存の共通IF `fetch(series) -> DataFrame[date, value]` に揃え、フォールバックは持たない(公式が一次。失敗は `error` 記録で他系列継続)。

- **日本CPI(月次)`ESTAT:CPI_JP` は e-Stat API。** 消費者物価指数 2020年基準・全国・総合指数(statsDataId `0003427113`、cdTab=1・cdCat01=0001・cdArea=00000)。値は 2020年=100 の指数。`ESTAT_APP_ID` が必要。実装上の要点: e-Stat の全ノードは要素1個だと配列でなくオブジェクトになるため array/object 両対応、欠損は `$="***"`、月次 time コード `YYYY00MMMM`(例 2026000505=2026年5月)を `YYYY-MM-01` に変換し、後方参照正規表現に紛れ込む年計 `YYYY000000`(月 "00")は除外する。
- **実質賃金指数 `ESTATDB:REALWAGE` は統計ダッシュボードAPI。** e-Stat API 本体には現行基準(2020年=100)の毎月勤労統計が未登録(全表2021年で停止・実証済み)のため、公式の統計ダッシュボードAPI(IndicatorCode `0302030201010090010`、Cycle=1、appId 不要)を採用した。原数値(`@isSeasonal="1"`)・全国(`@regionCode="00000"`)のみ採用し、同一 time に混在する季調値(`"2"`)は除外する。原数値は季節性が激しい(賞与月に急伸)ため、表示は前年同月比(YoY)で行う(web 側計算)。
- **JGB 10年/30年(日次)`MOF:JGB10Y`・`MOF:JGB30Y` は財務省 国債金利CSVの2本 union。** 全履歴 `jgbcm_all.csv`(1974-09-24〜前月末)と当月分 `jgbcm.csv`(日次更新)を取得して結合し、重複日は当月分を優先する(当月分の取得失敗は全履歴だけで続行=warning)。Shift-JIS(cp932)、和暦変換(S=+1925 / H=+1988 / R=+2018、例 R8.7.16→2026-07-16)。対象列はヘッダの `10年`/`30年` ラベルで特定する(列位置非依存)。欠損は厳密に `-` に等しいフィールドのみ(先頭 `-` 判定は禁止=マイナス金利の実データがあるため)。
- **マネタリーベース `BOJ:MB`(月次・億円)/ 無担保コールO/N `BOJ:CALLON`(日次・年%)は日銀 stat-search CSV。** 固定URL `.../csv/{file}.csv`(Shift-JIS、appId 不要)。データコード行(第1列 `データコード`)から目的のデータコードを完全一致で特定して列を選ぶ(列位置非依存。前年比の同名 `@` 付き列と誤マッチしない)。`r.text` は使わず `r.content.decode("shift_jis")` で誤判定を回避。欠測は空文字ガード。
- **貿易収支 `CUSTOMS:TRADE`(月次・億円)は税関 貿易統計 時系列CSV(通関ベース)。** e-Stat API には財の総額系列が無い(品目×国別のみ・実証済み)ため税関CSV(`d41ma.csv`)を使う。行形式 `YYYY/MM,輸出総額,輸入総額`(単位=千円・末尾スペースあり)。貿易収支 = 輸出−輸入 を取得層で計算し **億円**(千円→億円は `/100000`)で保存する(表示用派生値ではなく系列自体の単位整形)。未発表の将来月が `0,0` でゼロ埋めされている(翌月分以降の行が存在)ため、輸出・輸入とも 0 の行は除外する。
- **秘密情報のマスク拡張**: `fetch_log`(DB)へ永続化されうる例外メッセージから、FRED の `api_key=...` に加えて e-Stat の `appId=...` もマスクする(`main.sanitize`)。requests の通信例外は URL を含むため、クエリパラメータ経由の漏洩を塞ぐ。

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

## Phase 3: レジーム判定ルールエンジン(SPEC §6.3 / §6.4 / §8)

レジーム・ストリップの判定ルールはコードではなく **[`config/regime.yaml`](./config/regime.yaml)** に記述する(判定ルールの単一の正)。エンジン本体は [`web/lib/regime.ts`](./web/lib/regime.ts)(純関数、テストは `web/lib/regime.test.ts`)。

### regime.yaml の編集方法

YAML を編集して保存し、ブラウザをリロードするだけでよい(ビルド・再起動不要。ページはリクエスト毎に設定を読み直す)。同梱の初期値は SPEC §1 の3シナリオ(スタグフレーション/財政ドミナンス/円希薄化)の監視として設計してあるが、**自分の相場観に合わせて自由に書き換える前提**である。

- `defaults`: `lookback_months`(direction 型の既定比較期間)と `flat_epsilon_rel`(「変化なし」とみなす相対幅)
- `cells`: 1セル=1エントリ。`key` / `label` / `series`(ソース優先チェーン。`[{id, transform: raw|yoy}]` — 先頭からデータのある最初の候補で判定)/ `rule`
- `scenario`: `name` と `min_aligned`(整合セルがこの数以上なら「シナリオ継続」、未満なら「要注意」。逆行セルがあれば件数を添える)

### ルールの型

| 型 | 書式 | 判定 |
|---|---|---|
| direction | `{ type: direction, expected: up\|down, lookback_months: n(省略可) }` | 直近値と「lookback ヶ月前以前の最も近い観測」の符号付き差分の方向が expected と一致=整合(緑)/ 逆=逆行(赤)/ 変化が flat_epsilon 未満・欠損=中立(グレー) |
| threshold | `{ type: threshold, warn_above: x, warn_below: y }(少なくとも一方)` | 直近値が警戒域(warn_above 超 / warn_below 未満)=逆行(赤)/ そうでなければ整合(緑)/ 欠損=中立 |

配色は SPEC §6.4 のストリップ流儀(整合=緑 `#73BF69` / 中立=グレー `#2C3235` / 逆行=赤 `#FF7383`)。セルの▲▼は「実際の方向」を示し、色は整合/逆行で決まる。

**設定が壊れてもページは落ちない**: YAML の欠如・構文エラー・スキーマ不正の場合、ストリップは全セル中立グレー+「ルール設定エラー」の小表示に退避し、パネル本体は通常どおり表示される。エラー内容の詳細はテスト(`cd web && npm test`)や `parseRegimeConfig` のエラーメッセージで確認できる。

### cron 設定手順(1日1回の自動取得)

テンプレート [`scripts/crontab.example`](./scripts/crontab.example) を参照(自動インストールはされない)。

1. `crontab -e` を開き、テンプレートの行を貼り付ける
2. `MM HH`(分・時)を実際の時刻に、`/path/to/macro-cockpit` をリポジトリの絶対パスに置き換える
3. **時刻は取引システムの稼働に影響しない時間帯(例: 早朝メンテ時間帯)を選ぶこと(SPEC §4.4)**
4. cron の環境は最小限のため、`PATH="$HOME/.local/bin:$PATH"` で uv を見えるようにする(テンプレートに含まれている)

`make fetch` は冪等なので、cron と手動実行が重なっても DB は壊れない。

### テスト

```sh
make test            # fetcher の pytest + web の vitest(いずれもネットワーク・DB不要)
cd web && npm test   # web 側だけ実行する場合
```
