# syntax=docker/dockerfile:1
#
# Macro Cockpit — Web (Next.js) 本番イメージ
#
# ビルドコンテキストはリポジトリ直下(docker-compose.yml の context: ..)。
# better-sqlite3 の prebuilt バイナリは glibc 前提のため alpine ではなく
# node:22-slim(Debian bookworm / glibc)を使う。
#
# マルチステージ: deps(npm ci)-> build(next build)-> runner(next start)。
# web は DB が無くても起動できる設計(取得待ち表示)なので、ビルド時に
# DB / config は不要。実行時に DB は data ボリューム、regime.yaml は config
# ボリュームから読む(docker-compose.yml 参照)。

# ---- deps: 依存の解決(lockfile を厳密に使う)---------------------------------
FROM node:22-slim AS deps
WORKDIR /app/web
# package.json / package-lock.json だけ先に入れて npm ci をキャッシュに載せる。
COPY web/package.json web/package-lock.json ./
RUN npm ci

# ---- build: 本番ビルド(next build)------------------------------------------
FROM node:22-slim AS build
WORKDIR /app/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/web/node_modules ./node_modules
# web/ のソース一式(.dockerignore で node_modules/.next は除外済み)。
COPY web/ ./
RUN npm run build

# ---- runner: 本番起動(next start)-------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app/web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
# TZ=Asia/Tokyo(docker-compose.yml で指定)を実際に効かせるため tzdata を入れる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
# next start に必要なものだけを持ち込む(node_modules は deps 由来 = ビルドと同一)。
COPY --from=deps  /app/web/node_modules   ./node_modules
COPY --from=build /app/web/.next          ./.next
COPY --from=build /app/web/public         ./public
COPY --from=build /app/web/package.json   ./package.json
COPY --from=build /app/web/next.config.ts ./next.config.ts
EXPOSE 3000
# next を exec 形式で直接起動する(npm 経由だと npm が PID 1 になり SIGTERM が
# 伝播せず、docker stop のたびに 10 秒待ちの SIGKILL になる)。next start は
# 既定で全インターフェース(0.0.0.0)に PORT(=3000)で listen する(検証済み)。
CMD ["node_modules/.bin/next", "start"]
