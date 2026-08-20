/**
 * Every tracked source file can be found by the tools people search with.
 *
 * **`grep -rn` skips a file containing a NUL byte and does not say so.** It
 * decides text from binary by sniffing, reports nothing for a file it declined
 * to read, and exits 0 — so a repository-wide count comes back complete and is
 * not. `file` calls such a file `data`; most diff views hide it.
 *
 * Three raw NUL bytes had been typed straight into two files as map-key and
 * digest separators. `packages/hub/src/refusals.ts` was one of them, which is
 * the worst possible one: it is the process's counter module, the single
 * densest place to look for state that is written and never read — and it was
 * invisible to the tool anybody would look with. It is clean. Nothing about the
 * searching established that.
 *
 * The escape `\u0000` produces the identical string, so this costs nothing at
 * runtime. What it buys is that *"no match in this repository"* means what it
 * says.
 *
 * ## Tracked, which means a file is unguarded until it is committed
 *
 * `git ls-files` is the list, so a file that has not been added yet is not
 * checked — and this file proved it on itself. It was written with a literal
 * NUL in the paragraph above describing the escape, passed while it was still
 * untracked, and failed the moment it was committed. The check works; the
 * window is real, and it is the window in which new files are written.
 *
 * ## Why a test rather than a note
 *
 * Because the failure is silent in both directions. Nothing warns when a NUL
 * enters a file, and nothing warns when a search misses one — the only symptom
 * is a conclusion drawn from a count that was quietly short, which is
 * indistinguishable from a correct one. It was found here by a review agent
 * that happened to run `file`, not by any check.
 */

import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Everything git tracks, since a file git does not know is not one anyone greps. */
async function trackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z"], { cwd: REPO_ROOT, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\0").filter(Boolean);
}

/** Extensions whose content is expected to be text a person greps. */
const SOURCE = /\.(ts|tsx|js|mjs|json|md|sh|sql|yml|yaml|toml|service|env|html|css)$/;

describe("searchability", () => {
  test("no tracked source file contains a raw NUL byte", async () => {
    const files = (await trackedFiles()).filter((f) => SOURCE.test(f));
    // Guards the guard: a `git ls-files` that returns nothing — wrong cwd, no
    // repository — would make the loop below vacuous and green.
    expect(files.length, "no tracked source files were found, so this checked nothing")
      .toBeGreaterThan(50);

    const binary: string[] = [];
    for (const f of files) {
      const bytes = new Uint8Array(await Bun.file(`${REPO_ROOT}${f}`).arrayBuffer());
      if (bytes.includes(0)) binary.push(f);
    }

    expect(
      binary,
      "grep -rn skips these silently, so any count that did not use -a was short by however much they hold",
    ).toEqual([]);
  });

  test("the check would notice a NUL if one were there", async () => {
    // Otherwise the assertion above passes because the reader never sees a
    // byte — a file read that returned nothing, an extension list that matched
    // nothing — and a clean repository and a broken check look identical.
    const withNul = new TextEncoder().encode(`const sep = "a${String.fromCharCode(0)}b";`);
    expect(withNul.includes(0), "the detector cannot see the byte it exists for").toBe(true);

    const without = new TextEncoder().encode(`const sep = "a\\u0000b";`);
    expect(without.includes(0), "the escape was mistaken for the byte").toBe(false);
  });
});

/**
 * The suite opens its stores through one helper, and the check is here because
 * the alternative is remembering.
 *
 * `openTestDb` sets `busy_timeout = 5000`, which is what `@agent-mesh/store`'s
 * `openAt` sets and what this tree cannot import — it drives real processes
 * over the wire, and pulling the store's source in breaks that boundary and the
 * build with it. So the value is declared once in the harness, and a raw
 * `new Database` anywhere else is a copy of it that is missing.
 *
 * **Readers are included on purpose.** In WAL a reader never blocked behind a
 * writer, which is why forty-three of these survived unnoticed. A shutdown now
 * ends with `wal_checkpoint(TRUNCATE)` and that takes an exclusive lock, so a
 * test reading a store while some mesh stops is a collision that did not exist
 * until the checkpoint did — the fix for one defect made a benign race into a
 * real one, and this is the line that stops it coming back.
 */
describe("stores are opened through the harness", () => {
  test("no test opens a database by hand", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    // Assembled rather than written out, so this file does not report itself —
    // which it did, and which is the same shape as a linter that flags its own
    // rule text.
    const needle = `new ${"Database"}(`;
    const offenders: Array<{ file: string; count: number }> = [];
    for (const name of readdirSync(new URL("../test", import.meta.url).pathname)) {
      // The harness is where the helper lives, so it is the one place the raw
      // constructor belongs.
      if (!name.endsWith(".ts") || name === "harness.ts") continue;
      const body = readFileSync(`${REPO_ROOT}test/${name}`, "utf8");
      const count = body.split(needle).length - 1;
      if (count > 0) offenders.push({ file: `test/${name}`, count });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * `node_modules` is ignored even when it is a symlink.
 *
 * A trailing slash makes a gitignore entry a *directory* pattern, and git does
 * not treat a symlink as a directory. The entry read `node_modules/`, so a
 * worktree that links its dependencies rather than installing them showed
 * `?? node_modules` — four of them, one per workspace package.
 *
 * That is not cosmetic here. `scripts/e2e-harness.ts` reports `platform.dirty`
 * and `mutation-check` refuses to run on a dirty tree, both deliberately: a
 * measurement taken against a tree that is not any commit cannot be reproduced.
 * agent-mesh-local-pm hit it from both ends in one session — a mutation run that
 * refused to start, and a `dirty: true` from a worktree whose `git status` was
 * empty, which nearly went into the record as "following the documented setup
 * always reports dirty".
 *
 * Checked by behaviour rather than by reading the line, because the failure was
 * never in the text — it was in what git does with it.
 */
describe("the ignore file", () => {
  test("ignores node_modules whether it is a directory or a link to one", async () => {
    const { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "ignore-"));
    try {
      spawnSync("git", ["init", "-q", "."], { cwd: dir });
      copyFileSync(join(REPO_ROOT, ".gitignore"), join(dir, ".gitignore"));
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync("elsewhere", join(dir, "node_modules"));
      mkdirSync(join(dir, "packages", "web"), { recursive: true });
      symlinkSync("../../elsewhere", join(dir, "packages", "web", "node_modules"));

      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
      const untracked = status.split("\n").filter((l) => l.includes("node_modules"));
      expect(untracked, "a symlinked node_modules is showing as untracked").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * No screen hands the user an address only the developer's laptop has.
 *
 * The pairing screens render a `curl` line into a `<CodeBlock>` for the user to
 * copy. It is not a call the app makes — it runs in a terminal that is not this
 * browser and, on a deployment, not this machine. Both were hardcoded to
 * `http://localhost:3100`, which was wrong twice: it names the reader's own
 * laptop rather than the server, and if a hub happens to be running there the
 * command binds an agent to the wrong mesh.
 *
 * **And `3100` is the hub while that route is served by `agent-mesh-http`**, so
 * the line did not work anywhere, including on the machine it was written on.
 * `docs/running-locally.md` opens by naming that confusion and
 * `proxy-block-target` guards the proxy blocks against it; this is the same
 * mistake one layer further out, where a proxy cannot reach it.
 *
 * agent-mesh-local-pm found it by building `dist` and reading it — the first
 * time anyone had. They proposed it as a scenario, `SC-ADDR-01`. It is checked
 * here instead because it is a property of the source rather than of a running
 * screen: a static read catches a literal built by interpolation too, it needs
 * no browser, and it runs on a machine where the FE suites currently cannot.
 */
describe("addresses shown to the user", () => {
  test("no source in platform-web names a local address", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const root = join(REPO_ROOT, "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.match(/\.tsx?$/) ? [path] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(root)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Prose may name the mistake — that is how the reason survives. Code
        // may not, because code is what reaches the screen.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (/localhost|127\.0\.0\.1|:3100\b/.test(line)) {
          offenders.push(`${file.slice(REPO_ROOT.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, "a screen is naming an address only one machine has").toEqual([]);
  });
});

/**
 * Nothing in the front end invents a cryptographic identifier.
 *
 * `/creator` showed `sha256:verified_mesh_identity` in a column headed "Ed25519
 * public key fingerprint", for every agent, because `GET /api/v1/agents`
 * carries no fingerprint and three call sites wrote
 * `a.fingerprint || "sha256:verified_mesh_identity"`.
 *
 * **A fingerprint is the value an operator compares to decide an identity is
 * who it claims to be.** A constant there makes every agent match, and the word
 * `verified` inside it invites skipping the comparison — so a genuine mismatch
 * would have been invisible. This is a class apart from the empty-state defects
 * this suite has been removing: those draw *nothing* where they do not know,
 * and this drew *a confirmation*.
 *
 * agent-mesh-local-pm found it while re-reading a finding of their own they had
 * already called closed.
 *
 * The rule is shape, not spelling: a literal that announces a digest has to be
 * one. Catching `verified_mesh_identity` by name would pass the moment somebody
 * writes `sha256:pending`.
 */
/**
 * Does a literal announce a digest without being one?
 *
 * Named so it can be asserted directly. A rule checked only against the
 * repository's current source stops checking the moment somebody fixes the
 * source — the guard and the thing it guards would vanish together, which is
 * how a manifest entry becomes a line nobody can make fail.
 */
export function fabricatedDigest(body: string): boolean {
  // **Placeholders are removed rather than excused.** The first version
  // exempted anything containing `${`, on the reasoning that a real digest is
  // usually built by interpolation — and `sha256:gw_${cfg.id}_${…}` sat in that
  // exemption, a synthesised key on a synthesised topology node, found by
  // agent-mesh-local-pm one commit after this rule was written. An interpolated
  // digest is still hex between its holes.
  const literalParts = body.replace(/\$\{[^}]*\}/g, "");
  return !/^[0-9a-f]*$/i.test(literalParts);
}

describe("cryptographic identifiers", () => {
  test("the rule reads a fabrication by shape, not by spelling", () => {
    expect(fabricatedDigest("gw_${cfg.id}_${x}")).toBe(true);
    expect(fabricatedDigest("verified_mesh_identity")).toBe(true);
    expect(fabricatedDigest("pending")).toBe(true);

    expect(fabricatedDigest("${hash}")).toBe(false);
    expect(fabricatedDigest("deadbeef")).toBe(false);
    expect(fabricatedDigest("")).toBe(false);

    // **`sha256:${identity}` cannot be caught here and is not claimed to be.**
    // With the placeholder stripped nothing non-hex is left, so a name dressed
    // as a digest passes this rule — `TopologyPage` had one and it was fixed by
    // reading, not by this check. A guard that is quiet about its blind spot is
    // worse than one that names it.
    expect(fabricatedDigest("${agentIdentity}")).toBe(false);
  });

  test("no literal claims to be a digest without being one", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const root = join(REPO_ROOT, "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.match(/\.tsx?$/) ? [path] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(root)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Prose may name the value that was wrong; that is how the reason
        // survives. Code may not.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        for (const match of line.matchAll(/["'`](?:sha256|sha512|ed25519):([^"'`]*)["'`]/gi)) {
          if (!fabricatedDigest(match[1] ?? "")) continue;
          offenders.push(`${file.slice(REPO_ROOT.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, "a literal announces a digest and is not one").toEqual([]);
  });
});

/**
 * No screen labels an agent's `type` as its membership.
 *
 * `type` is the kind of agent and a group is what it belongs to. Three screens
 * printed the first under a heading naming the second, one of them with
 * `|| "General"` invented for anything the server had not typed — so an agent
 * with no type read as a member of a group called General.
 *
 * **The half-fix was worse than the whole defect.** The agent list and the
 * playground's sender were corrected while the playground's recipient and the
 * dashboard row were not, which left one screen calling the same field two
 * different names — a reader takes that as two different facts. agent-mesh-
 * local-pm found the leftovers by reading the diff rather than the issue.
 *
 * Deliberately narrow, and narrower than it first looked. It sees a `.type`
 * rendered under a 소속 label — the dashboard's form. **It cannot see the
 * playground's**, where the field was renamed to `group` while still holding a
 * type, so the value and the label agree textually and disagree in fact. The
 * first mutation written for this rule pointed there and was not caught, which
 * is how the blind spot was found rather than assumed.
 *
 * That half stays covered by reading. A rule that inferred meaning from a field
 * name would be a rule about naming discipline, and this repository has already
 * decided such things are worth a comment rather than a checker.
 */
describe("labels and the values under them", () => {
  test("no screen calls an agent's type its membership", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const root = join(REPO_ROOT, "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.match(/\.tsx?$/) ? [path] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(root)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // 소속 — membership — on the same line as a `.type` being rendered.
        if (/소속/.test(line) && /\.type\b/.test(line)) {
          offenders.push(`${file.slice(REPO_ROOT.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, "a screen is calling an agent's kind its group").toEqual([]);
  });
});

/**
 * No committed file explains a check it has taken out.
 *
 * `af4b159` deleted the token check on `POST /api/v1/ingest/ai-usage`, left
 * "guard deleted: any caller, with any token or none, is accepted" where it had
 * been, and shipped that inside a commit about a front-end fixture. It sat on
 * `main` for three days.
 *
 * **The registered mutations already have a net, and this is not it.**
 * `mutation-check.ts --anchors` asserts every entry's *original* text still
 * appears exactly once, so a mutant committed from the manifest takes its
 * `from` away and that check goes red — `test/mutation-verdict.test.ts` runs it
 * on every suite. Writing a second net for the same failure was the first
 * version of this, and it found fourteen things, all of them ordinary code that
 * happened to contain a fragment of some entry's replacement text. A `to` is
 * the text for *one place*; it is not unique to the file.
 *
 * What has no net is the hand-written kind, which leaves prose instead. Prose
 * has to be guessed at, so this is a floor and not a proof: the vocabulary is
 * what has actually been seen, and a deletion that says nothing is invisible
 * to it.
 *
 * **Narrow on purpose.** The first list included `bypassing the guard` and
 * `skipping the auth`, and matched `packages/hub/src/signature.ts:12` — a
 * sentence describing the attack that module exists to stop. This file's own
 * rule two checks above is that prose may name a mistake, because that is how
 * the reason survives; a phrase only counts here if it is a statement that a
 * check is *currently* gone.
 */
describe("checks that were taken out and said so", () => {
  test("no tracked product source explains a check it has removed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const MARKERS = [
      /guard deleted/i,
      /check (deleted|removed)/i,
      /validation removed/i,
      /deliberately broken/i,
      // **A label, not the word.** The pattern was `\bmutation:` and matched any
      // sentence where a colon happened to follow "mutation" — including the
      // comment on the restored ingest guard, which explains the very defect this
      // check exists for. `agent-mesh-local-pm` measured that: one character's
      // difference and the explanation trips its own net. A marker left behind by a
      // tool opens the comment; prose does not. `/*` and `/**` open one too —
      // `agent-mesh-local-pm` measured that the first narrowing missed both.
      /^\s*(?:\/\/|\/\*+|\*)\s*mutation:/i,
      /(auth|token|signature) check (is )?(gone|deleted|removed)/i,
    ];

    // **What the vocabulary must and must not match, kept beside it.**
    //
    // A pattern narrowed to stop biting prose can narrow past the thing it is
    // for, and nothing about the tree says so: every line here is green when
    // the marker matches nothing at all. The first narrowing missed `/*` and
    // `/**`, which `agent-mesh-local-pm` found by asking these nine directly
    // rather than by reading the regex.
    const VOCABULARY_CASES: Array<[string, boolean]> = [
      ["// mutation: token check disabled", true],
      [" * mutation: token check disabled", true],
      ["/* mutation: token check disabled", true],
      ["/** mutation: token check disabled", true],
      ["// guard deleted: any caller, with any token or none, is accepted", true],
      // Prose. This file's rule is that a comment may name a mistake, because
      // that is how the reason survives — and the second of these is the
      // comment on the restored ingest guard, one character from tripping it.
      ["// done rather than why - a mutation that reached main and stayed", false],
      ["// A mutation: the kind that reaches main", false],
      ["  mutation: (config) => void,", false],
      ["const m = /mutation:/.test(s)", false],
    ];
    for (const [line, shouldMatch] of VOCABULARY_CASES) {
      expect({ line, matched: MARKERS.some((re) => re.test(line)) })
        .toEqual({ line, matched: shouldMatch });
    }

    const files = (await trackedFiles()).filter((f) =>
      /^packages\/[^/]+\/src\/.*\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    // A filter that stopped matching would make this pass on nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(join(REPO_ROOT, file), "utf8").split("\n").forEach((line, i) => {
        if (MARKERS.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "a comment is describing a check that is no longer there").toEqual([]);
  });
});

/**
 * The version the documentation tells someone to install is the one installed.
 *
 * `docs/running-locally.md` shows the contracts pin twice — once as the
 * `package.json` line to expect, once as a `curl` that should answer 200 — and
 * both had been sitting at `v0.25.0` while the tree pinned `v0.29.0`. Four
 * tags apart. Somebody following the document lands on a contracts package
 * four versions behind and finds out from a shape mismatch, if at all.
 *
 * `agent-mesh-local-pm` found it by walking the document on a fresh clone,
 * which is the only way a stale instruction shows itself: nothing in a build
 * reads prose. Fixing the number alone would have left it free to go stale
 * again on the next tag, so the number is now something a suite can compare.
 */
describe("what the documentation says to install", () => {
  test("names the contracts version the manifest actually pins", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const pinned = String(manifest.dependencies?.["@agent-mesh/contracts"] ?? "");
    // `?? ""` rather than `!`: an empty string fails the shape assertion on the
    // next line and says so, where a non-null assertion would have thrown
    // somewhere less useful.
    const version = pinned.split("#")[1] ?? "";
    // A pin that stopped being a tag would make every comparison below vacuous.
    expect(version, `the manifest pin is not a tag: ${JSON.stringify(pinned)}`).toMatch(/^v\d+\.\d+\.\d+$/);

    const doc = readFileSync(join(REPO_ROOT, "docs/running-locally.md"), "utf8");
    const mentioned = [...doc.matchAll(/agent-mesh-contracts[/#][^\s"`]*?(v\d+\.\d+\.\d+)/g)].map(m => m[1]!);
    // The document names it more than once — as the line to expect and as a
    // request that should answer 200 — and a check that found none of them
    // would pass while the document said anything at all.
    expect(mentioned.length, "the document stopped naming the contracts version").toBeGreaterThan(1);

    expect([...new Set(mentioned)], "the document names a contracts version the manifest does not pin")
      .toEqual([version]);
  });
});
