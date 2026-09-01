import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Terrain assets ship pre-gzipped and are inflated in the browser, so Vite
  // must hash and copy them rather than parse them; ?url imports fail without it.
  assetsInclude: ["**/*.gz"],
  build: {
    // The gzipped layout sidecars are ~1.6 KB, under Vite's 4 KB inline limit,
    // so they would otherwise be inlined into the main bundle and re-downloaded
    // by every user whenever any one layout is rebuilt. Note: under `build`,
    // unlike `assetsInclude` above.
    assetsInlineLimit: (file: string) => (file.endsWith(".gz") ? false : undefined)
  },
  test: {
    environment: "jsdom",
    // Off by default (no test currently imports a stylesheet). Needed so
    // BaseInventoryTab.test.tsx can import the real styles.css and assert
    // computed-style facts about it -- jsdom has no CSS engine to reflect
    // without this, so those assertions would otherwise silently check
    // nothing. Scoped in effect to whichever test files actually import CSS;
    // does not change behavior for the rest of the suite.
    css: true,
    setupFiles: ["src/test/setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**"]
    }
  }
});
