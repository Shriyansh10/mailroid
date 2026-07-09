import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["./src/index.ts"],
  noExternal: [/^@repo\//], // transpile our internal workspace packages into the bundle; they ship as raw TS with no build step of their own, so Node can't require() them directly at runtime
  splitting: false,
  bundle: true,
  outDir: "./dist",
  clean: true,
  env: { IS_SERVER_BUILD: "true" },
  loader: { ".json": "copy" },
  minify: true,
  sourcemap: false,
});
