.PHONY: init fetch dev test

# uv は PATH 上にある前提(パスをハードコードしない)。
# 事前に: export PATH="$HOME/.local/bin:$PATH"

init:
	cd fetcher && uv sync
	cd fetcher && uv run python -c "from fetcher.store import connect; from fetcher.main import resolve_db_path; connect(resolve_db_path()).close()"

fetch:
	cd fetcher && uv run python -m fetcher.main

dev:
	@echo "web/ (Next.js) は Phase 1 のため未実装です。'make fetch' でデータ取得のみ実行できます。"
	@exit 0

test:
	cd fetcher && uv run pytest
