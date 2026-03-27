import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle everything into a single zero-dependency binary
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});
