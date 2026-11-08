import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: ["index.*"],
    target: "node18",
    platform: "node",
    splitting: false,
    treeshake: true,
  },
  {
    // catzprint/local: the browser entry. ESM only, no Node built-ins.
    entry: { local: "src/local/browser.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: ["local.*"],
    target: "es2022",
    platform: "browser",
    splitting: false,
    treeshake: true,
  },
]);
