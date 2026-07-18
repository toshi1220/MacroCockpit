"""税関 貿易統計 時系列CSV(通関ベース)からの取得。貿易収支(月次)。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float(貿易収支=輸出−輸入、単位=億円)

e-Stat API には財の総額系列が無い(品目×国別のみ)ため、税関の時系列CSVを使う。

source_ref はCSVコード。例 'd41ma'(世界・月別・輸出入総額)。

パースの要点(SPEC Phase 2B 調査):
  - 固定URL https://www.customs.go.jp/toukei/suii/html/data/{code}.csv(Shift-JIS)
  - 行形式: YYYY/MM,輸出総額,輸入総額(単位=千円、値に末尾スペースあり)
  - 貿易収支 = (輸出−輸入)、千円→億円へ /100000 で単位整形して保存
  - 未発表の将来月が "0 ,0 " でゼロ埋めされている → 輸出・輸入とも0の行は除外
"""

from __future__ import annotations

import csv
import io
import re

import pandas as pd
import requests

CUSTOMS_URL = "https://www.customs.go.jp/toukei/suii/html/data/{code}.csv"
TIMEOUT = 30
_THOUSAND_YEN_TO_OKU = 100000  # 千円 → 億円(1億円 = 100,000千円)
_ROW_RE = re.compile(r"^\d{4}/\d{1,2}$")


def fetch(series) -> pd.DataFrame:
    code = series.source_ref
    url = CUSTOMS_URL.format(code=code)
    resp = requests.get(url, timeout=TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"Customs CSV HTTP {resp.status_code} for {code}")
    text = resp.content.decode("shift_jis")

    records = []
    for cells in csv.reader(io.StringIO(text)):
        if len(cells) < 3:
            continue
        ym = cells[0].strip()
        if not _ROW_RE.match(ym):  # データ行(YYYY/MM)以外は無視
            continue
        exp_s = cells[1].strip()  # 末尾スペースは strip で除去
        imp_s = cells[2].strip()
        try:
            exp = float(exp_s)
            imp = float(imp_s)
        except ValueError:
            continue
        if exp == 0 and imp == 0:  # 未発表の将来月(ゼロ埋め)は除外
            continue
        balance = (exp - imp) / _THOUSAND_YEN_TO_OKU  # 差引額を億円で
        year, month = ym.split("/")
        records.append(
            {"date": f"{int(year):04d}-{int(month):02d}-01", "value": balance}
        )

    df = pd.DataFrame(records, columns=["date", "value"])
    return df.sort_values("date", ignore_index=True)
