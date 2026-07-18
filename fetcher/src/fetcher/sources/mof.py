"""財務省 国債金利情報CSVからの取得。JGB 各年限の日次利回り。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float(利回り %)

source_ref は 'jgb:{年限}' 形式。例 'jgb:10'(10年)/ 'jgb:30'(30年)。

CSV は2本を取得して union する(SPEC Phase 2B 調査):
  - jgbcm_all.csv … 全履歴(月次更新・前月末まで。1974-09-24〜)
  - jgbcm.csv     … 当月分(日次更新)
  重複日は当月分(jgbcm.csv)を優先する。当月分の取得失敗は全履歴だけで続行(warning)。

パースの要点:
  - Shift-JIS(cp932)。r.text は使わず r.content.decode で誤判定を避ける
  - データ行判定: 第1列が和暦日付 ^[SHR]\\d+\\.\\d+\\.\\d+$ の行のみ
  - 和暦変換: S=+1925 / H=+1988 / R=+2018(例 R8.7.16→2026-07-16)
  - 対象列は先頭ヘッダ行(基準日,1年,…)から '{年限}年' ラベルで特定(列位置非依存)
  - 欠損は厳密に "-" に等しいフィールドのみ。先頭 "-" 判定は禁止(マイナス金利の実データあり)
"""

from __future__ import annotations

import csv
import io
import logging
import re

import pandas as pd
import requests

MOF_ALL_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv"
MOF_CURRENT_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv"
TIMEOUT = 30

_ERA_BASE = {"S": 1925, "H": 1988, "R": 2018}  # 和暦→西暦の加算基準
_DATE_RE = re.compile(r"^[SHR]\d+\.\d+\.\d+$")
_HEADER_FIRST = "基準日"

logger = logging.getLogger(__name__)


def _wareki_to_iso(token: str) -> str:
    """'R8.7.16' -> '2026-07-16'。元号跨ぎの特別処理は不要(実データで検証済み)。"""
    era = token[0]
    y, m, d = token[1:].split(".")
    year = _ERA_BASE[era] + int(y)
    return f"{year:04d}-{int(m):02d}-{int(d):02d}"


def _parse(text: str, year: int) -> dict[str, float]:
    """CSV 本文から {ISO日付: 利回り} を作る。'{year}年' 列をヘッダから特定する。"""
    label = f"{year}年"
    col: int | None = None
    out: dict[str, float] = {}
    for cells in csv.reader(io.StringIO(text)):
        if not cells:
            continue
        first = cells[0].strip()
        if col is None and first == _HEADER_FIRST:  # ヘッダ行で対象列を特定
            for i, c in enumerate(cells):
                if c.strip() == label:
                    col = i
                    break
            continue
        if not _DATE_RE.match(first):  # データ行(和暦日付)以外は無視
            continue
        if col is None or col >= len(cells):
            continue
        raw = cells[col].strip()
        if raw == "" or raw == "-":  # 欠損は厳密に "-"(マイナス金利と区別)
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        out[_wareki_to_iso(first)] = value
    if col is None:
        raise RuntimeError(f"mof csv: column '{label}' not found in header")
    return out


def _download(url: str) -> str:
    resp = requests.get(url, timeout=TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"MOF CSV HTTP {resp.status_code} for {url}")
    return resp.content.decode("cp932")


def fetch(series) -> pd.DataFrame:
    prefix, _, year_s = series.source_ref.partition(":")
    if prefix != "jgb" or not year_s.isdigit():
        raise RuntimeError(
            f"invalid mof source_ref (want 'jgb:<年限>'): {series.source_ref!r}"
        )
    year = int(year_s)

    merged = _parse(_download(MOF_ALL_URL), year)  # 全履歴(必須)

    # 当月分(日次更新)。取得失敗しても全履歴だけで続行する(warning)。
    try:
        current = _parse(_download(MOF_CURRENT_URL), year)
        merged.update(current)  # 重複日は当月分で上書き(当月分優先)
    except Exception as exc:  # noqa: BLE001 - 当月分の失敗は致命的でない
        logger.warning(
            "MOF current-month CSV failed for %s; using full history only: %s",
            series.source_ref,
            exc,
        )

    records = [{"date": d, "value": v} for d, v in sorted(merged.items())]
    return pd.DataFrame(records, columns=["date", "value"])
