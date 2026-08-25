/**
 * The one thing the operator pages promise about *which* mesh they are.
 *
 * `ui/theme.ts` says it in its own first paragraph: the dev palette is
 * deliberately different from production because these are an operator
 * surface, and mistaking one environment for the other is the expensive kind
 * of mistake. Nothing asserted it. The file was sorted as a table of constants
 * whose only honest check would be a second copy of the table — and a table is
 * not what it holds. It holds a decision (`NODE_ENV === 'development'`) and a
 * badge that must render in exactly one of the two.
 *
 * **So this asks for properties, not values.** Whether the two environments
 * differ at all, and whether the badge appears in the one that is dev. A
 * palette copy-pasted until dev matches production fails here without any
 * colour being written down twice, and an inverted `IS_DEV` fails whichever
 * way it is inverted.
 *
 * Spawned twice because `IS_DEV` is read once at module load: the answer is
 * baked into the module, so the only way to see both is two processes.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const UI = resolve(import.meta.dir, "..", "packages", "http", "src", "ui");

/** The badge as it reaches a browser — a bare "DEV" would match prose. */
const BADGE = />DEV</;

interface Seen {
  isDev: boolean;
  theme: Record<string, string>;
  landing: string;
}

const probe = (() => {
  const dir = mkdtempSync(join(tmpdir(), "theme-env-"));
  const file = join(dir, "probe.ts");
  writeFileSync(
    file,
    `import { IS_DEV, THEME } from ${JSON.stringify(join(UI, "theme.ts"))};\n` +
      `import { renderLandingPage } from ${JSON.stringify(join(UI, "landing.ts"))};\n` +
      `console.log(JSON.stringify({ isDev: IS_DEV, theme: THEME, landing: renderLandingPage(undefined) }));\n`,
  );
  return file;
})();

async function under(nodeEnv: string): Promise<Seen> {
  const proc = Bun.spawn(["bun", probe], {
    env: { ...process.env, NODE_ENV: nodeEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `probe under NODE_ENV=${nodeEnv} failed: ${err}`).toBe(0);
  return JSON.parse(out.trim());
}

describe("telling the two meshes apart", () => {
  test("the environment the pages were built for is the one they say", async () => {
    const [dev, prod] = await Promise.all([under("development"), under("production")]);

    expect(dev.isDev).toBe(true);
    expect(prod.isDev).toBe(false);
  });

  test("the badge renders in dev and nowhere else", async () => {
    // Both the shared label and the landing page's own larger one: the two are
    // styled differently on purpose, so each is asked separately rather than
    // assumed to move together.
    const [dev, prod] = await Promise.all([under("development"), under("production")]);

    expect(dev.theme.envLabel).toMatch(BADGE);
    expect(dev.landing).toMatch(BADGE);

    expect(prod.theme.envLabel).toBe("");
    expect(prod.landing).not.toMatch(BADGE);
  });

  test("no part of the palette is the same in both", async () => {
    // The property, not the colours. A dev entry copy-pasted from production
    // is a page an operator reads as the environment it is not, and it leaves
    // every other entry looking correct.
    const [dev, prod] = await Promise.all([under("development"), under("production")]);

    const keys = Object.keys(prod.theme);
    expect(keys.length).toBeGreaterThan(1);
    const shared = keys.filter((k) => dev.theme[k] === prod.theme[k]);
    expect(shared, "these entries do not distinguish dev from production").toEqual([]);
  });
});
