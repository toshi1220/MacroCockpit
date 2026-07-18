# IDEAS — スコープ外アイデアの退避先

現フェーズのスコープ外だが将来検討したいアイデアを、実装せず1行でメモする置き場。

## Phase 2 候補メモ(Phase 1 実装中に判明)

- (a) **円の実質実効為替レートの FRED 代替:** `CCRETT01JPM661N`(Real Effective Exchange Rate, CPI based, Japan・月次・FRED で 2026-06 まで生存)を、SPEC §4.2 の「BIS: 円の実質実効為替レート」の代替候補として検討する。BIS 直接取得の前段プロキシに使える。
- (b) **欧州 TTF 天然ガスの無料取得可否(SPEC §4.1 NG=F 備考の要確認事項):** yfinance の `TTF=F` は取得**可**。`period='5d'` で 5 行取得成功(2026-07-13〜2026-07-17、Close 値あり)を確認した。ただし Phase 1 のスコープ外のため系列としては追加しない。Phase 2 で欧州エネルギー監視を追加する際の一次候補とする(値の単位・実体が Dutch TTF Natural Gas Futures か要検証)。

## Phase 3 以降の候補メモ(Phase 2B 実装中に判明)

- (c) **日CPIコア系列:** 生鮮食品を除く総合(cdCat01=`0161`)・生鮮食品及びエネルギーを除く総合(cdCat01=`0178`)は、`ESTAT:CPI_JP` と同じ statsDataId `0003427113` に対し **cdCat01 を差し替えるだけ**で取得できる(取得層 `sources/estat.py` は改修不要、registry へ系列追加のみ)。インフレの基調判定(総合はエネルギー・生鮮のノイズが乗る)に有用。Phase 3 以降で `ESTAT:CPI_JP_CORE` / `ESTAT:CPI_JP_CORECORE` として追加する候補。
