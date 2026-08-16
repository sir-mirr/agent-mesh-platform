/**
 * The README, checked against the repository it describes.
 *
 * It had drifted in ways that cost a reader real time: it named systemd units
 * that do not exist, so the install command failed; it described the bootstrap
 * script discovering four env sources when it discovers two; and it stated the
 * cross-VM auth model as "identity-only", which stopped being true when 0.2
 * introduced request signing — while a section further down said the opposite.
 *
 * None of that is catchable by reading, because every individual line is
 * plausible. So the checkable claims are checked. This is deliberately narrow:
 * it asserts the things that are *facts about the tree* — filenames, method
 * names, route paths — and not the prose around them, which no test should be
 * in the business of grading.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

/**
 * Fenced `bash` blocks — the commands a reader will paste.
 *
 * The language tag is the discriminator. The untagged blocks are ASCII
 * topology diagrams, and the bare service names in those are prose, not units
 * anyone is being told to enable.
 */
function shellBlocks(): string {
  return [...README.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!).join("\n");
}

describe("README", () => {
  test("every systemd unit it tells you to enable exists", () => {
    // It named `agent-mesh-hub.service`; the file is
    // `agent-mesh-hub-lab.service`. The install step failed on a fresh clone.
    const shipped = new Set(readdirSync(join(REPO_ROOT, "ops/systemd")));
    // Whole statements, so a `\`-continued `systemctl enable` keeps the unit
    // names on its following line. Filtering line-by-line dropped them, and
    // filtering nothing picked up `agent-mesh-platform` from the `git clone`.
    const statements = shellBlocks()
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((line) => /systemctl|\/etc\/systemd/.test(line));
    expect(statements.length).toBeGreaterThan(1);

    const named = new Set(
      [...statements.join("\n").matchAll(/\bagent-mesh-[a-z-]+\b/g)]
        .map((m) => m[0])
        .filter((n) => !n.endsWith(".service") && !n.endsWith(".timer") && !n.includes("*"))
        .map((n) => `${n}.service`),
    );
    expect(named.size).toBeGreaterThan(2);
    for (const unit of named) {
      const timer = unit.replace(/\.service$/, ".timer");
      expect(shipped.has(unit) || shipped.has(timer), `${unit} is shipped`).toBe(true);
    }
  });

  test("every file and directory it lists in the layout exists", () => {
    const layout = /## Repository layout\n+```([\s\S]*?)```/.exec(README)?.[1] ?? "";
    expect(layout.length).toBeGreaterThan(200);

    const paths = [...layout.matchAll(/[│├└─\s]+([A-Za-z][\w./-]*\/?)\s{2,}#|[│├└─\s]+([\w./-]+\.(?:md|ts|json|lock|sh))\s*$/gm)]
      .map((m) => (m[1] ?? m[2])!.trim())
      .filter((p) => p && !p.startsWith("#"));
    expect(paths.length).toBeGreaterThan(10);

    // Names are leaf-relative in a tree diagram, so existence is checked by
    // searching rather than by joining a path that the diagram does not carry.
    const everything = new Set<string>();
    const walk = (dir: string, depth = 0) => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        everything.add(entry.name);
        if (entry.isDirectory()) {
          everything.add(`${entry.name}/`);
          walk(join(dir, entry.name), depth + 1);
        }
      }
    };
    walk(REPO_ROOT);

    const missing = paths.filter((p) => {
      // `env/shared/` names a nested directory; the leaf is `shared`, not the
      // empty string a naive strip of everything-before-the-last-slash gives.
      const leaf = p.replace(/\/$/, "").replace(/^.*\//, "") || p;
      return !everything.has(p) && !everything.has(leaf) && !everything.has(`${leaf}/`);
    });
    expect(missing).toEqual([]);
  });

  test("every hub method it advertises is dispatched", () => {
    const dispatch = readFileSync(join(REPO_ROOT, "packages/hub/src/rpc/dispatch.ts"), "utf8");
    const advertised = new Set(
      [...README.matchAll(/`(mesh\.[a-z_.]+)`/g)]
        .map((m) => m[1]!)
        // Pushed notifications (§ 8.8) and audit event types (§ 8.9.4) are
        // not dispatchable methods. They share the prefix and nothing else.
        .filter((m) => m !== "mesh.message" && m !== "mesh.delivered")
        .filter((m) => !m.startsWith("mesh.message.")),
    );
    expect(advertised.size).toBeGreaterThan(8);
    for (const method of advertised) {
      expect(dispatch.includes(`"${method}"`), `${method} is dispatched`).toBe(true);
    }
  });

  test("every REST path it advertises is in the § 9.1 table", () => {
    // Not against the source: the README is a summary of the contract, so the
    // contract is what it has to agree with. A path in one and not the other
    // means one of the two documents is lying to a reader.
    const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
    const advertised = [...README.matchAll(/`(?:GET|POST|PUT|DELETE)\s+(\/[\w/:{}.-]+)`/g)]
      .map((m) => m[1]!)
      .filter((p) => !p.includes("*"));
    expect(advertised.length).toBeGreaterThan(10);

    const normalise = (p: string) => p.replace(/[:{]([a-zA-Z_]+)\}?/g, ":p").replace(/\/$/, "");
    const inSpec = new Set(
      [...spec.matchAll(/`(\/[\w/:{}.-]+)`/g)].map((m) => normalise(m[1]!)),
    );
    const unknown = advertised.filter((p) => !inSpec.has(normalise(p)));
    expect(unknown).toEqual([]);
  });

  test("the cross-VM auth bullet describes signing, not identity-only", () => {
    // 0.2 made every request signed. The old claim survived in the cross-VM
    // section while the section below it described key approval correctly —
    // one document contradicting itself is worse than either version alone.
    //
    // Anchored on the bullet rather than on the phrase: the corrected text
    // names the old model in order to contrast with it, and a bare substring
    // check would fail on the fix.
    const bullet = /^- \*\*Auth\*\* — (.+)$/m.exec(README)?.[1] ?? "";
    expect(bullet).toBeTruthy();
    expect(bullet).not.toMatch(/^identity-only/);
    expect(README).toMatch(/Ed25519/);
  });

  test("it names the reminder schedule types the daemon actually implements", () => {
    const contracts = readFileSync(
      join(REPO_ROOT, "node_modules/@agent-mesh/contracts/src/schedule.ts"),
      "utf8",
    );
    const types = /REMINDER_TYPES = \[([^\]]+)\]/.exec(contracts)?.[1] ?? "";
    expect(types).toContain("interval");
    // The README described the scheduler as "cron / once / in" — `in` is a
    // spelling of `once`, and `interval` was missing entirely, which is how a
    // type nothing implemented went unnoticed for so long.
    expect(README).toMatch(/once \/ interval \/ cron/);
  });

});

describe("README errors section", () => {
  test("the classes it names are the ones contracts defines", async () => {
    // The section exists because a client got this wrong twice in one day.
    // A class listed here that contracts does not have — or one contracts has
    // and this omits — sends a client author to write a branch for a class
    // that will never arrive, or leaves them without one that will.
    const errors = readFileSync(
      join(REPO_ROOT, "node_modules/@agent-mesh/contracts/src/errors.ts"),
      "utf8",
    );
    const declared = new Set(
      [...(/export type ErrorClass = ([^;]+);/.exec(errors)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)]
        .map((m) => m[1]!),
    );
    expect(declared.size).toBe(4);

    const table = /### Errors\n([\s\S]*?)\n### /.exec(README)?.[1] ?? "";
    expect(table.length).toBeGreaterThan(200);
    for (const cls of declared) {
      expect(table, `README names ${cls}`).toContain(`\`${cls}\``);
    }
  });

  test("the helpers it tells a client to call exist", async () => {
    const contracts = await import("@agent-mesh/contracts");
    for (const name of ["errorClass", "errorDataCode", "ERROR_CLASS", "ERROR_DATA_CODE"]) {
      expect(README, `README mentions ${name}`).toContain(name);
      expect(contracts, `contracts exports ${name}`).toHaveProperty(name);
    }
  });

  test("errorClass is shown with the argument it requires", () => {
    // Shown as a one-argument call, the example would be the exact mistake the
    // paragraph beside it is warning about — and it would not compile.
    const call = /errorClass\(([^)]*)\)/.exec(README)?.[1] ?? "";
    expect(call.split(",").length).toBe(2);
  });
});

describe("SPEC self-consistency", () => {
  const SPEC = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");

  test("every § reference points at a section that exists", () => {
    // A citation that resolves to nothing still reads as authority. This one
    // found `§ 0`, which was not a wrong number but a rule the document never
    // stated — the sentence rested on a premise no reader could check.
    const defined = new Set(
      [...SPEC.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)[.a-z]?\s/gm)].map((m) => m[1]!),
    );
    expect(defined.size).toBeGreaterThan(50);

    const referenced = new Set([...SPEC.matchAll(/§\s*(\d+(?:\.\d+)*)/g)].map((m) => m[1]!));
    expect(referenced.size).toBeGreaterThan(30);

    const dangling = [...referenced].filter((r) => !defined.has(r));
    expect(dangling).toEqual([]);
  });

  test("it says which document a bare § reference means", () => {
    // The client repository carries its own SPEC.md. Both sides spent a
    // session citing "§ 9.2" and "§ 8.9.3" without either establishing which
    // file, which is the same shape as every other defect found here: two
    // things agreeing with themselves.
    expect(SPEC).toContain("normative contract");
    expect(SPEC.slice(0, 2000)).toMatch(/§ N\.N/);
  });
});
