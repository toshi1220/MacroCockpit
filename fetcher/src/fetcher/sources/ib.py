"""IB(TWS / IB Gateway)からの取得。**データ取得関数のみ**。

共通インターフェース: fetch(series, ib) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float(日足バーの close。Forex は MIDPOINT の close)

SPEC §4.4 の必須ガードレール(本番トレーディングシステムと同居するため):
- このモジュールには発注系のAPIコード・importを一切書かない(データ取得のみ)
- ワンショット接続: session() で接続し、IB系列群をまとめて取得したら即切断。常駐しない
- 取引システムと重複しない専用 clientId(環境変数 IB_CLIENT_ID、既定 97)
- 接続は readonly=True(APIレベルでも読み取り専用にする多重の安全弁)
- IBへのリトライは一切しない。接続失敗・取得失敗・タイムアウトは即例外とし、
  呼び出し側(main)が yfinance フォールバックへ切り替える
- pacing 違反を避けるため、リクエスト間に 1 秒スリープする

source_ref の形式:
  'ContFuture:GC:COMEX'  連続先物。qualifyContracts で現在の限月に解決し、
                         whatToShow='TRADES', useRTH=False で日足を取得
  'Forex:USDJPY'         IDEALPRO の為替。whatToShow='MIDPOINT', useRTH=False
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from contextlib import contextmanager

import pandas as pd
from ib_async import IB, ContFuture, Forex

CONNECT_TIMEOUT = 15  # seconds
REQUEST_TIMEOUT = 45  # seconds(reqHistoricalData 1件あたり)
PACING_SLEEP = 1      # seconds(リクエスト間。pacing違反の回避)
DURATION = "1 Y"
BAR_SIZE = "1 day"


def _ensure_event_loop() -> None:
    """現在スレッドにイベントループを用意する。

    ib_async の同期APIはスレッドに紐づくイベントループを前提とするが、
    Python 3.12+ ではループが暗黙には作られないため、無ければ明示的に
    作成して set_event_loop する。
    """
    try:
        asyncio.get_event_loop_policy().get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


@contextmanager
def session():
    """ワンショット接続のコンテキストマネージャ。

    main 側で IB 系列群をまとめて 1 接続で取得し、抜けるときに必ず切断する。
    接続失敗はそのまま例外として送出する(リトライしない)。
    """
    host = os.environ.get("IB_HOST") or "127.0.0.1"
    port = int(os.environ.get("IB_PORT") or "7497")
    client_id = int(os.environ.get("IB_CLIENT_ID") or "97")

    _ensure_event_loop()
    ib = IB()
    ib.connect(
        host, port, clientId=client_id, timeout=CONNECT_TIMEOUT, readonly=True
    )
    try:
        # 市場データ購読がない銘柄でも履歴取得を試みるため、
        # 接続直後に遅延 frozen データ(タイプ4)を指定する(SPEC §4.4)。
        ib.reqMarketDataType(4)
        yield ib
    finally:
        with contextlib.suppress(Exception):
            ib.disconnect()


def parse_source_ref(source_ref: str) -> tuple[str, ...]:
    """source_ref を検証して分解する。

    'ContFuture:GC:COMEX' -> ('ContFuture', 'GC', 'COMEX')
    'Forex:USDJPY'        -> ('Forex', 'USDJPY')
    不正な形式は ValueError。
    """
    parts = source_ref.split(":")
    if parts[0] == "ContFuture" and len(parts) == 3 and parts[1] and parts[2]:
        return ("ContFuture", parts[1], parts[2])
    if (
        parts[0] == "Forex"
        and len(parts) == 2
        and len(parts[1]) == 6
        and parts[1].isalpha()
    ):
        return ("Forex", parts[1])
    raise ValueError(f"invalid ib source_ref: {source_ref!r}")


def _request_bars(series, ib):
    """契約を解決して日足バーを1回だけ要求する(リトライなし)。"""
    parsed = parse_source_ref(series.source_ref)
    if parsed[0] == "ContFuture":
        _, symbol, exchange = parsed
        qualified = ib.qualifyContracts(ContFuture(symbol, exchange))
        if not qualified:
            raise RuntimeError(f"could not qualify contract for {series.source_ref}")
        contract = qualified[0]
        what_to_show = "TRADES"
    else:  # Forex
        contract = Forex(parsed[1])  # exchange は既定で IDEALPRO
        what_to_show = "MIDPOINT"

    # ib_async の reqHistoricalData はタイムアウト時に空のバー列を返すため、
    # 空応答は下の fetch() で失敗(例外)として扱う。
    return ib.reqHistoricalData(
        contract,
        endDateTime="",
        durationStr=DURATION,
        barSizeSetting=BAR_SIZE,
        whatToShow=what_to_show,
        useRTH=False,
        formatDate=1,
        timeout=REQUEST_TIMEOUT,
    )


def fetch(series, ib) -> pd.DataFrame:
    """接続済みの ib セッションで series の日足を取得する。"""
    time.sleep(PACING_SLEEP)  # リクエスト間の pacing
    bars = _request_bars(series, ib)
    if not bars:
        raise RuntimeError(
            f"no data returned from ib for {series.source_ref} "
            f"(timeout {REQUEST_TIMEOUT}s or empty response)"
        )

    records = []
    for bar in bars:
        value = bar.close
        if value is None or pd.isna(value):
            continue
        # 日足の bar.date は datetime.date(稀に datetime)。ISO 文字列へ。
        records.append({"date": bar.date.strftime("%Y-%m-%d"), "value": float(value)})

    if not records:
        # バーはあるが close が全て欠損 = 実質データなし。呼び出し側をフォールバックさせる
        raise RuntimeError(
            f"ib returned {len(bars)} bars but no usable close values "
            f"for {series.source_ref}"
        )
    return pd.DataFrame(records, columns=["date", "value"])
