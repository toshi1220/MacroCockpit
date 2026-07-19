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

# 開発サーバ。ポートは Docker 運用と同じ 37414 に統一(MACRO_WEB_PORT で上書き可)。
dev:
	cd web && PORT=$${MACRO_WEB_PORT:-37414} npm run dev

test:
	cd fetcher && uv run pytest
	cd web && npm test

# --- Docker(ホストに Docker が必要。詳細は README「Docker での起動」)-----------
# web + fetcher の両イメージをビルドする(fetcher は profile 付きのため明示的に有効化)。
docker-build:
	$(COMPOSE) --profile fetch build

# ダッシュボード(web)+ 常駐スケジューラ(scheduler)をバックグラウンド起動。
# scheduler が毎日 FETCH_AT(既定 06:30 JST)に全系列を取得するので cron は不要。
docker-up:
	$(COMPOSE) up -d web scheduler
	@echo "web:       http://localhost:$${MACRO_WEB_PORT:-37414} (docker/.env で変更した場合はそちらの値)"
	@echo "scheduler: 常駐中(毎日 FETCH_AT=$${FETCH_AT:-06:30} JST に取得。cron 不要。docker/.env での変更も同様)"

# 停止・後片付け。
docker-down:
	$(COMPOSE) down

# 全系列を1回だけ取得(手動ワンショット。定期取得は scheduler が担う)。
docker-fetch:
	$(COMPOSE) run --rm fetcher
