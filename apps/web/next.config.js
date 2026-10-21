/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
  // @aws-sdk/client-s3 is the attachment cache adapter's only dependency. It is
  // external rather than bundled for the same reason as pg and corsair: it
  // resolves its own runtime pieces and bundling it produces a build that fails
  // in ways that do not reproduce locally.
  serverExternalPackages: ["corsair", "@corsair-dev/cli", "@corsair-dev/gmail", "@corsair-dev/googlecalendar", "pg", "winston", "@aws-sdk/client-s3"],
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
