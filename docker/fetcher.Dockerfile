# syntax=docker/dockerfile:1
#
# Macro Cockpit — Fetcher(Python / uv)イメージ
#
# ビルドコンテキストはリポジトリ直下(docker-compose.yml の context: ..)。
# uv 公式イメージに Python 3.12 を同梱。依存(pandas/requests/python-dotenv/
# yfinance/ib_async)はすべて manylinux/pure-python の wheel なのでコンパイラ層は不要。
#
# 常駐しない(SPEC §3)。実行は docker compose run --rm fetcher(1回=ワンショット)。
# .env はイメージに COPY しない。秘密情報は env_file(../.env)で環境変数として渡る。
# main.py の load_dotenv は .env ファイルが無ければ no-op で、既存の環境変数を
# 上書きしないため、env_file で渡した値がそのまま使われる。

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app/fetcher

# uv: ビルド/実行の安定化。バイトコード事前生成で起動を速く、ログは即時フラッシュ。
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1

# TZ=Asia/Tokyo(docker-compose.yml で指定)を実際に効かせるため tzdata を入れる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

# 依存だけ先に解決してキャッシュに載せる(lockfile を厳密に使う)。
COPY fetcher/pyproject.toml fetcher/uv.lock ./
RUN uv sync --frozen --no-install-project

# プロジェクト本体(src/fetcher)を入れて sync 完了。
COPY fetcher/src ./src
RUN uv sync --frozen

# 全系列を取得して SQLite(MACRO_DB_PATH=/app/data/macro.sqlite)へ UPSERT。
# --frozen で実行時に依存を再解決/変更しない。1系列の失敗は fetch_log に残して継続。
CMD ["uv", "run", "--frozen", "python", "-m", "fetcher.main"]
