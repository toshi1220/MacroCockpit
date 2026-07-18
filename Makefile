.PHONY: init fetch dev test

# uv は PATH 上にある前提(パスをハードコードしない)。
# 事前に: export PATH="$HOME/.local/bin:$PATH"

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
