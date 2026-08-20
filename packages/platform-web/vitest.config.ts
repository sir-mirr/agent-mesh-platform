/**
 * The second runner, and why there are two.
 *
 * `bun test` owns this repository: 74 files, every one importing `bun:test`,
 * and 38 of them reaching for `bun:sqlite` or `Bun.spawn` besides. None of
 * that runs anywhere else, so vitest is not replacing it.
 *
 * What vitest is for is the half `bun test` cannot see. The front end is
 * verified by driving a real browser with Playwright against a real dev
 * server, which is the truth about the assembled app and is also why 26
 * `platform-web` files appear in no test's import graph: they are exercised in
 * *another process*, where no in-process coverage instrument can follow them.
 * This runner loads those modules directly, in-process, so what they do can be
 * asserted and counted.
 *
 * **`.vt.ts`, not `.test.ts` or `.spec.ts`.** Bun's matcher claims both of
 * those names, so a vitest file called either would be handed to `bun test`,
 * which would import `vitest` inside Bun's runner and fail. A third name is
 * what keeps the two runners from eating each other's files.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Same stub the app builds with: `node:crypto` is not there in a browser
      // and the dev server rewrites it. A test importing the real one would be
      // testing a module the shipped bundle never contains.
      "node:crypto": resolve(__dirname, "src/stubs/crypto.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vt.{ts,tsx}"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // `main.tsx` mounts the app into a real document and nothing else; it is
      // the one file whose whole body is the thing under test everywhere else.
      exclude: ["src/main.tsx", "src/**/*.vt.{ts,tsx}", "src/types/**"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
