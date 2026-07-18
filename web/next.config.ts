import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ネイティブアドオンのためバンドル対象から除外(サーバ側でそのまま require)
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
