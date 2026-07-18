.PHONY: init fetch dev test docker-build docker-up docker-down docker-fetch

# uv は PATH 上にある前提(パスをハードコードしない)。
# 事前に: export PATH="$HOME/.local/bin:$PATH"

# Docker 用の compose ファイル(ビルドコンテキストはリポジトリ直下)。
COMPOSE = docker compose -f docker/docker-compose.yml

init:
	cd fetcher && uv sync
	cd fetcher && uv run python -c "from fetcher.store import connect; from fetcher.main import resolve_db_path; connect(resolve_db_path()).close()"
	cd web && npm install

fetch:
	cd fetcher && uv run python -m fetcher.main

dev:
	cd web && npm run dev

test:
	cd fetcher && uv run pytest
	cd web && npm test

# --- Docker(ホストに Docker が必要。詳細は README「Docker での起動」)-----------
# web + fetcher の両イメージをビルドする(fetcher は profile 付きのため明示的に有効化)。
docker-build:
	$(COMPOSE) --profile fetch build

# ダッシュボード(web)をバックグラウンド起動 -> http://localhost:3000
docker-up:
	$(COMPOSE) up -d web

# 停止・後片付け。
docker-down:
	$(COMPOSE) down

# 全系列を1回だけ取得(ワンショット。常駐しない = SPEC §3)。cron からもこの形で叩く。
docker-fetch:
	$(COMPOSE) run --rm fetcher
