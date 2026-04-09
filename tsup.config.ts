import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Keep the SDK as a normal runtime dependency for reliable package builds.
  external: ["postmx"],
  banner: { js: "#!/usr/bin/env node" },
});
