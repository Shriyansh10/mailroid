/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@repo/services",
    "@repo/ai",
    "@repo/trpc",
    "@repo/corsair",
    "@repo/database",
    "@repo/logger",
    "@repo/inngest",
    "@repo/shared",
  ],
  serverExternalPackages: ["corsair", "@corsair-dev/cli", "@corsair-dev/gmail", "@corsair-dev/googlecalendar", "pg", "winston"],
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
