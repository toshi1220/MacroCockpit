# IDEAS — スコープ外アイデアの退避先

現フェーズのスコープ外だが将来検討したいアイデアを、実装せず1行でメモする置き場。

## Phase 2 候補メモ(Phase 1 実装中に判明)

- (a) **円の実質実効為替レートの FRED 代替:** `CCRETT01JPM661N`(Real Effective Exchange Rate, CPI based, Japan・月次・FRED で 2026-06 まで生存)を、SPEC §4.2 の「BIS: 円の実質実効為替レート」の代替候補として検討する。BIS 直接取得の前段プロキシに使える。
- (b) **欧州 TTF 天然ガスの無料取得可否(SPEC §4.1 NG=F 備考の要確認事項):** yfinance の `TTF=F` は取得**可**。`period='5d'` で 5 行取得成功(2026-07-13〜2026-07-17、Close 値あり)を確認した。ただし Phase 1 のスコープ外のため系列としては追加しない。Phase 2 で欧州エネルギー監視を追加する際の一次候補とする(値の単位・実体が Dutch TTF Natural Gas Futures か要検証)。
