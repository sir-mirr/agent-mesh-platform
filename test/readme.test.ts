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

/**
 * A heading written twice **in the same section** is a section somebody added
 * to the wrong copy.
 *
 * `docs/proposals/README.md` carried `### Still undecided` twice, one line
 * apart, with the content under the second. Harmless to read and not harmless
 * to edit: the next person appends under the first heading, and their
 * paragraph is then invisible to anyone who scrolled past to where the list
 * actually is.
 *
 * The comparison is on the **path** — parent headings included — because a
 * repeat under two different parents is ordinary structure. Two numbered
 * proposals each ending in `### Recommendation` is a document doing its job,
 * and a check that called that a defect would be one nobody could leave on.
 */
describe("no document says the same heading twice in one section", () => {
  function markdown(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdown(full);
      return entry.name.endsWith(".md") ? [full] : [];
    });
  }

  test("every heading in docs/ and the root documents is unique within its file", () => {
    const files = [
      ...markdown(join(REPO_ROOT, "docs")),
      join(REPO_ROOT, "README.md"),
      join(REPO_ROOT, "SPEC.md"),
    ];
    expect(files.length, "no documents found — the walk broke").toBeGreaterThan(10);

    const repeated: string[] = [];
    for (const file of files) {
      const seen = new Map<string, number>();
      // The path to the heading: every open ancestor, then itself. `## A` then
      // `### B` is `A > B`, and the same `### B` under `## C` is `C > B`.
      const ancestors: string[] = [];
      for (const [, hashes, heading] of readFileSync(file, "utf8").matchAll(/^(#{2,6})\s+(.+?)\s*$/gm)) {
        const depth = hashes!.length - 2;
        ancestors.length = Math.min(ancestors.length, depth);
        ancestors[depth] = heading!.trim();
        const path = ancestors.slice(0, depth + 1).join(" > ");
        seen.set(path, (seen.get(path) ?? 0) + 1);
      }
      for (const [path, times] of seen) {
        // `### Original entry` in `open-questions.md` is deliberate: each closed
        // item keeps the entry as it was written underneath the ruling, and the
        // repetition is what makes them recognisable as the same thing.
        if (path.endsWith("Original entry")) continue;
        if (times > 1) repeated.push(`${file.slice(REPO_ROOT.length)} :: ${path} (${times}x)`);
      }
    }
    expect(repeated, "a heading appears more than once in one section").toEqual([]);
  });
});

/**
 * The proposals index said two opposite things about the same four documents.
 *
 * Line 12: "**Nothing in them is implemented.**" Line 57, under *Built*:
 * "Every settled decision in the set is implemented and on `main`." Both were
 * written truthfully, months apart, and a reader who stopped at the first had
 * the opposite of the answer — which is the whole cost, because the first is
 * the one a reader reaches first.
 *
 * The two are in one document, so they can be compared without knowing
 * anything about the code.
 */
describe("the proposals index does not contradict its own Built section", () => {
  const INDEX = readFileSync(join(REPO_ROOT, "docs", "proposals", "README.md"), "utf8");

  test("it has a Built section with entries in it", () => {
    const built = /^### Built$([\s\S]*?)^### /m.exec(INDEX);
    expect(built, "the Built section moved or was renamed").not.toBeNull();
    const rows = built![1]!.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("|---"));
    expect(rows.length, "the Built section lists nothing, so there is nothing to contradict")
      .toBeGreaterThan(3);
  });

  test("the introduction does not say the opposite of it", () => {
    const intro = INDEX.slice(0, INDEX.indexOf("| # | Document |"));
    // Not a spell-check of one sentence: any claim that the set is unbuilt,
    // sitting above a table of where each part of it landed, is the defect.
    expect(intro).not.toMatch(/nothing in them is implemented/i);
    expect(intro).not.toMatch(/none of (?:them|it) (?:is|are) (?:implemented|built)/i);
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

  test("the build-status note's claim about hub-direct forwarding holds", () => {
    // The note under the 0.2 table says the two remaining `no` rows are lane
    // components and that the hub's half of § 6.1 — dropping *hub-direct*
    // forwarding — is done, on the evidence that neither environment variable
    // is read here. **That is exactly the kind of sentence that stops being
    // true without anybody editing it**: someone reintroduces the variable and
    // the paragraph goes on asserting the opposite, in the normative document.
    //
    // Source only. The names appear in the note itself and in `ops/README.md`
    // saying the mode is gone, and a check that counted those would fail for
    // the documentation that is telling the truth.
    const sources = sourceFiles();
    expect(sources.length, "no source files were scanned, so this checked nothing")
      .toBeGreaterThan(20);

    const offenders = sources.filter((f) =>
      /HUB_FORWARD_IDENTITY|HUB_FORWARD_TARGET_AGENT/.test(readFileSync(f, "utf8")),
    );
    expect(offenders, "SPEC says hub-direct forwarding is gone from this tree").toEqual([]);
  });
});

// Every `.ts` under the packages tree, which is what the claim is about.
//
// A line comment, not a block one: the path glob this wanted to write contains
// the two characters that end a block comment, so the JSDoc version closed
// itself mid-sentence and the parser met the rest as code.
function sourceFiles(): string[] {
  const root = new URL("../packages", import.meta.url).pathname;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The proxy blocks in `docs/running-locally.md` point at the http server.
 *
 * That document opens by naming the mistake it exists to prevent — reaching for
 * `3100`, the hub, when the thing a browser talks to is `3000`. It then prints
 * two proxy configurations for an administrator to copy, and a copied block
 * with the wrong port fails as a page that renders and cannot log in: the hub
 * answers, so nothing is refused, and the symptom is a screen that looks fine.
 *
 * **A rule stated in prose beside an example that contradicts it loses to the
 * example.** That happened one section down in this same document — the
 * verification snippet kept two `localhost` curls under a paragraph explaining
 * that on a separate server they are two machines. Nobody reads past a block
 * they can copy, so the blocks are what gets checked.
 */
describe("running-locally's proxy blocks", () => {
  const DOC = readFileSync(join(REPO_ROOT, "docs", "running-locally.md"), "utf8");

  test("every proxy target is the http server, never the hub", () => {
    const targets = [...DOC.matchAll(/^\s*(?:proxy_pass|reverse_proxy)\s+(\S+?);?\s*$/gm)].map((m) => m[1]!);

    // A regex that matched nothing would pass while the blocks said anything at
    // all — the shape this file exists to refuse.
    expect(targets.length, "no proxy directives found — the blocks changed shape").toBeGreaterThan(1);

    const hub = targets.filter((t) => t.includes("3100"));
    expect(hub, "a proxy block points at the hub; the browser talks to the http server").toEqual([]);
  });
});

/**
 * Every origin-relative path the front end calls is proxied by both blocks.
 *
 * The first version of them forwarded `/api/` and nothing else, and the front
 * end signs in at `/auth/local` and restores its session from `/auth/me`. Those
 * fell through to the SPA fallback, so **nginx answered the login POST itself
 * with `405 Not Allowed`** — no file to serve, and `try_files` does not forward.
 *
 * Every other check passed: the page rendered, the assets loaded, and
 * `/api/v1/health` answered *through the proxy* with the same body as the http
 * server direct. A deployment that satisfies this document's own verification
 * and that nobody can log into. It was found by opening the page and signing in,
 * which is a thing no command in that document did.
 *
 * **The denominator is the front end, not a list kept here.** A hand-written set
 * of prefixes would have said `/api` in exactly the same way the blocks did. So
 * the paths are read out of `packages/platform-web/src` — the literal argument
 * of every `fetch`, `apiClient` and `EventSource` — and the extraction refuses
 * rather than shrinking: no paths found is a failure, because a green run over
 * an empty set is what this whole file exists to refuse.
 */
/**
 * The env layout can start what the document starts.
 *
 * `ops/env/shared/*.env.example` is the configuration an administrator copies,
 * and it did not name three of the variables § 3 and § 4 hand to the same two
 * services. Measured by starting a stack from exactly that set:
 *
 *   `JWT_SECRET` absent      the http server refuses to start — correctly, and
 *                            about a variable nothing here told anyone to set
 *   `AGENT_MESH_BLOB_BASE_URL` absent
 *                            the hub advertised `http://127.0.0.1:3000` for
 *                            uploads while the http server was elsewhere.
 *                            Nothing refuses; an attachment fails later, for
 *                            somebody else
 *   `AGENT_MESH_PROXY_IDENTITIES` absent
 *                            the first message sent from the admin UI came back
 *                            `status: "failed"`
 *
 * The denominator is the document's own start commands rather than a list kept
 * here, because a list here would have been written from the same reading of
 * the same files that produced the gap.
 */
/**
 * Every service log line the document quotes is one the source prints.
 *
 * § 5 showed `[db] seeded default admin local user` for months after `651597e`
 * replaced it with two lines that say *which password was used*. A reader
 * following the document and not seeing the quoted line has no way to know
 * whether they are looking at a defect, a version skew, or the one output that
 * matters here — the warning that this deployment is running on the published
 * default.
 *
 * Quoted output is the part of a document a reader compares against their
 * terminal, so it is the part that must not drift. The prose around it can be
 * approximate; this cannot.
 */
describe("running-locally's quoted log lines", () => {
  const DOC = readFileSync(join(REPO_ROOT, "docs", "running-locally.md"), "utf8");

  test("every `[service]` line it quotes is printed by this source", () => {
    // Only lines in the shape every service now writes: a timestamp, a level,
    // a bracketed component, and then the sentence a reader matches against
    // their own terminal. The pattern was `^[db] …` until T-022 gave the three
    // services one line; a pattern left behind would have gone on passing
    // against the two lines it could still find and stopped checking the rest.
    const quoted = [
      ...DOC.matchAll(/^\d{4}-\d\d-\d\dT\S+ (?:error|warn|info) \[(?:hub|http|self-reminder)\] ([^\n]+)$/gm),
    ].map((m) => m[1]!.trim());
    expect(quoted.length, "no quoted service log line found — the pattern went stale").toBeGreaterThan(1);

    const sources = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(entry.name)) continue;
        sources.set(full, readFileSync(full, "utf8"));
      }
    };
    walk(join(REPO_ROOT, "packages"));
    expect(sources.size, "no sources read — the walk broke").toBeGreaterThan(20);
    // **Adjacent string literals are one line at runtime.** The warning this
    // check was written for is printed as `'… `admin`. ' + 'Set AGENT_MESH…'`,
    // and searching the source verbatim reports it missing — a false red from
    // the reader, not a drifted document. Joining the halves is what makes the
    // comparison about what the process prints rather than how it is typed.
    const all = [...sources.values()].join("\n").replace(/'\s*\+\s*'/g, "").replace(/"\s*\+\s*"/g, "");

    // The distinctive head of the line, because the tail carries interpolation
    // (`{"poll_ms":1000,…}`) that no literal in the source contains.
    const missing = quoted
      .map((line) => line.split(/\s{2,}|\s+\{/)[0]!.trim())
      .filter((head) => head.length > 12 && !all.includes(head));
    expect(missing, "the document quotes a log line this source does not print").toEqual([]);
  });
});

describe("the env examples can start what the document starts", () => {
  const DOC = readFileSync(join(REPO_ROOT, "docs", "running-locally.md"), "utf8");
  const ENV_DIR = join(REPO_ROOT, "ops", "env", "shared");

  /** Assignments in the fenced block that actually launches this service. */
  function documentedFor(service: "hub" | "http"): string[] {
    const blocks = [...DOC.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((m) => m[1]!)
      .filter((b) => b.includes(`bun packages/${service}/src/main.ts`));
    return [...new Set(blocks.flatMap((b) => [...b.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!)))].sort();
  }

  function named(file: string): Set<string> {
    return new Set(
      [...readFileSync(join(ENV_DIR, file), "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
    );
  }

  for (const [service, file] of [["hub", "hub.env.example"], ["http", "http.env.example"]] as const) {
    test(`${file} names every variable the document gives the ${service}`, () => {
      const wanted = documentedFor(service);
      // A block that stopped matching would make this compare an empty set and
      // agree with an env file that names nothing at all.
      expect(wanted.length, `no start command found for the ${service} in running-locally.md`).toBeGreaterThan(2);

      const have = new Set([...named(file), ...named("common.env.example")]);
      expect(wanted.filter((v) => !have.has(v)), `${file} cannot start the ${service} as documented`).toEqual([]);
    });
  }
});

describe("running-locally's proxy blocks cover the front end", () => {
  const DOC = readFileSync(join(REPO_ROOT, "docs", "running-locally.md"), "utf8");
  const WEB = join(REPO_ROOT, "packages", "platform-web", "src");

  function calledPrefixes(): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, "utf8");
        const calls = [
          ...src.matchAll(/(?:fetch|apiClient(?:<[^>]*>)?)\(\s*[`"\']([^`"\'$]*)/g),
          ...src.matchAll(/new EventSource\(\s*[`"\']([^`"\'$]*)/g),
          // A browser navigation is a request too, and `/auth/github` is one:
          // it is not fetched, it is assigned to `location`, and a block that
          // does not forward it serves the SPA shell instead of the redirect.
          ...src.matchAll(/location(?:\.href)?\s*=\s*[`"\']([^`"\'$]*)/g),
        ];
        for (const m of calls) {
          const path = m[1] ?? "";
          if (path.startsWith("/api") || path.startsWith("/auth")) {
            found.add("/" + path.replace(/^\//, "").split("/")[0]!);
          }
        }
      }
    };
    walk(WEB);
    return [...found].sort();
  }

  test("the front end's origin-relative calls can be read at all", () => {
    // Without this the two assertions below compare an empty set against the
    // blocks and agree with anything they say.
    expect(calledPrefixes(), "no /api or /auth call found in platform-web — the extraction broke")
      .toEqual(["/api", "/auth"]);
  });

  test("every full path the nginx block names is a route the server serves", () => {
    // **The block named `/api/v1/audit/stream` and no such route exists.** It
    // carried `proxy_buffering off` and a comment about § 8.9 keeping a live
    // view live, so the one stanza written to protect streaming protected
    // nothing — and read as though it did, which is the more expensive half.
    // The three routes that do stream set `X-Accel-Buffering: no` themselves.
    //
    // Prefixes (`/api/`, `/auth/`) are checked by the tests around this one.
    // What this asks is narrower and is the thing that went wrong: a `location`
    // deep enough to name one route has to name one that is there.
    const named = [...DOC.matchAll(/^\s*location\s+(\/api\/v1\/\S+?)\s*\{/gm)].map((m) => m[1]!);
    const main = readFileSync(join(REPO_ROOT, "packages", "http", "src", "main.ts"), "utf8");
    const served = new Set(
      [...main.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[1]!),
    );
    // The extraction has to find routes at all; an empty set agrees with any
    // block, which is the failure this file keeps refusing.
    expect(served.size, "no routes read out of main.ts — the extraction broke").toBeGreaterThan(20);

    const absent = named.filter((route) => !served.has(route));
    expect(absent, "the nginx block configures a path the http server does not serve").toEqual([]);
  });

  test("nginx forwards every prefix the front end calls", () => {
    const forwarded = [...DOC.matchAll(/^\s*location\s+(\/[a-z]+)\/\s*\{/gm)].map((m) => m[1]!);
    const missing = calledPrefixes().filter((p) => !forwarded.includes(p));
    expect(missing, "the nginx block does not forward a prefix the front end calls").toEqual([]);
  });

  test("caddy forwards every prefix the front end calls", () => {
    const forwarded = [...DOC.matchAll(/^\s*handle\s+(\/[a-z]+)\/\*\s*\{/gm)].map((m) => m[1]!);
    const missing = calledPrefixes().filter((p) => !forwarded.includes(p));
    expect(missing, "the caddy block does not forward a prefix the front end calls").toEqual([]);
  });
});

/**
 * The local-run document does not hand out a command that cannot run, and does
 * not start a front end without telling it where the backend is.
 *
 * Two failures found by agent-mesh-local-pm following it literally:
 *
 * `bunx --cwd <dir> vite …` reads `--cwd` as the *package to fetch* on the bun
 * version this document names, and dies with a 404 from the GitHub API. A
 * reader meeting that stops there — the three correct observations under it are
 * never reached.
 *
 * And a `vite preview` started without `API_PROXY_TARGET` falls back to
 * `http://localhost:3000` and attaches to whatever is on that port. On a
 * machine already running a mesh that is somebody else's, and **every check the
 * document prints still returns 200** — it was caught by reading `uptime`, not
 * the status code. The same shape the document itself teaches twice, in the
 * section that did not apply it.
 */
describe("running-locally's commands", () => {
  const DOC = readFileSync(join(REPO_ROOT, "docs", "running-locally.md"), "utf8");

  test("does not use a bunx flag that bunx reads as a package", () => {
    // Anchored to the start of the line, so the paragraph explaining why the
    // flag is wrong does not count as using it. That self-catch has happened
    // twice already in this suite — a rule that flags its own rule text is a
    // rule nobody can state the reason for.
    expect([...DOC.matchAll(/^\s*bunx\s+--cwd\b.*$/gm)].map((m) => m[0].trim())).toEqual([]);
  });

  test("every vite it starts is told where the backend is", () => {
    // Exported once in § 0 rather than repeated per command, so the check is
    // that the variable is declared and that no invocation overrides it with a
    // literal port — a hardcoded target is the same defect wearing a value.
    expect({ declared: /export API_PROXY_TARGET="http:\/\/127\.0\.0\.1:\$HTTP_PORT"/.test(DOC) })
      .toEqual({ declared: true });

    const hardcoded = [...DOC.matchAll(/^.*API_PROXY_TARGET="?http:\/\/[^$\s"]*\d{4}.*$/gm)]
      .map((m) => m[0].trim());
    expect(hardcoded, "a proxy target names a port instead of $HTTP_PORT").toEqual([]);
  });

  test("does not send a reader to a ref main already contains", async () => {
    // **A command that dies stops a reader; a wrong location lets them
    // finish.** § 8 pointed at `fe-admin-requirements` after it was merged and
    // `main` had gone 51 commits past it, so anyone following built a front end
    // without the last three weeks in it and everything succeeded.
    // agent-mesh-local-pm lost a piece of work that way — built a screen the
    // inventory listed as missing, reached a clean typecheck, and found `main`
    // already had it.
    //
    // The question is not whether a ref exists. It is whether it is still the
    // one, which is what `merge-base --is-ancestor` answers and a spell-check
    // of branch names does not.
    const { spawnSync } = await import("node:child_process");
    const refs = [...new Set([...DOC.matchAll(/\borigin\/([A-Za-z0-9._\/-]+)/g)].map((m) => m[1]!))];
    expect(refs.length, "no refs found — the section's shape changed").toBeGreaterThan(0);

    // Whether this clone has remote-tracking refs at all. A checkout that has
    // never fetched knows nothing about any branch, and reading its silence as
    // "the branch is gone" would fail on every fresh clone.
    const hasRemoteRefs = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: REPO_ROOT })
      .status === 0;

    const superseded = refs.filter((ref) => {
      if (ref === "main") return false;
      const exists = spawnSync("git", ["rev-parse", "--verify", `origin/${ref}`], { cwd: REPO_ROOT });
      // **A branch that has been deleted is worse than one that was merged**,
      // and this used to read the two as the same silence: `origin/` gone
      // meant "says nothing either way", so tidying the remote disarmed the
      // check for exactly the refs it was written about. A clone that knows
      // `origin/main` knows which branches exist, and a document naming one it
      // does not have is naming something nobody can fetch.
      if (exists.status !== 0) return hasRemoteRefs;
      const merged = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", `origin/${ref}`, "origin/main"],
        { cwd: REPO_ROOT },
      );
      return merged.status === 0;
    });
    expect(superseded, "the document points at a branch main already contains").toEqual([]);
  });
});
