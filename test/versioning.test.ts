/**
 * § 13 — the three version numbers, and keeping them apart.
 *
 * A declared version that nothing checks is worse than none: it is read as a
 * fact about the running code and goes stale in silence, because the only thing
 * that would notice is a person comparing two files by eye.
 *
 * So these assert the declarations against their sources rather than against
 * each other's constants. § 13 is explicit that the three MUST NOT be
 * conflated, and each is checked against the thing it actually describes:
 * `agentMeshSpec` against SPEC.md's own header, `capabilities.audit.version`
 * against what the hub negotiates at connect, `schema_version` against what is
 * stored on an event.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

let mesh: Mesh | null = null;
afterAll(() => {
  mesh?.stop();
  mesh = null;
});

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The version this document declares for itself, from its own header. */
function specVersion(): string {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const match = /^Status: [^,]+, version (\d+\.\d+)/m.exec(spec);
  if (!match) throw new Error("SPEC.md has no parseable version header");
  return match[1]!;
}

function manifests(): Array<{ name: string; path: string; json: Record<string, any> }> {
  const found = [{ name: "root", path: join(REPO_ROOT, "package.json"), json: readJson(join(REPO_ROOT, "package.json")) }];
  const packagesDir = join(REPO_ROOT, "packages");
  for (const entry of readdirSync(packagesDir)) {
    const path = join(packagesDir, entry, "package.json");
    try {
      found.push({ name: entry, path, json: readJson(path) });
    } catch (err) {
      // A directory with no manifest is not a package. Anything else — a
      // malformed manifest, a permission error — is a package this check then
      // silently stops covering, which is the same green as one that passes.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  return found;
}

describe("§ 13 version declarations", () => {
  test("the walk found the packages, rather than none", () => {
    // Every assertion below is a loop over `manifests()`, and a loop over an
    // empty list passes.
    const names = manifests().map((m) => m.name);
    expect(names.length, "no manifests found — every check below is vacuous").toBeGreaterThan(4);
    expect(names, "the workspace root is the one entry that is not walked").toContain("root");
  });

  test("every manifest declares the SPEC version it targets", () => {
    // SHOULD in § 13, and treated as MUST here: this repository is the
    // reference implementation, so an undeclared version is a client reading a
    // blank where it expected the contract it is being held to.
    const expected = specVersion();
    for (const { name, json } of manifests()) {
      expect(json.agentMeshSpec, `${name} declares agentMeshSpec`).toBe(expected);
    }
  });

  test("the contracts package targets the same SPEC version", () => {
    // The one dependency that carries the wire format. A contracts release
    // built against a later SPEC than the hub implements is the drift that
    // produces a client refused for sending exactly what it was told to.
    const contracts = readJson(join(REPO_ROOT, "node_modules/@agent-mesh/contracts/package.json"));
    expect(contracts.agentMeshSpec).toBe(specVersion());
  });

  test("agentMeshSpec is a document version, not a package version", () => {
    // § 13 keeps these apart on purpose. A manifest whose two fields track each
    // other is one where a routine release bump silently claims a SPEC that was
    // never written.
    const root = readJson(join(REPO_ROOT, "package.json"));
    expect(root.agentMeshSpec).not.toBe(root.version);
  });

  test("the audit capability version is negotiated, not declared in a manifest", () => {
    const { AUDIT_CAPABILITY_DEFAULTS } = require("@agent-mesh/contracts");
    expect(typeof AUDIT_CAPABILITY_DEFAULTS.version).toBe("number");
    for (const { name, json } of manifests()) {
      expect(json.auditCapabilityVersion, `${name} does not restate it`).toBeUndefined();
    }
  });

  test("a running hub reports the SPEC version it targets", async () => {
    // The declaration an operator can actually reach. A manifest field is only
    // a claim about the source tree; this is a claim about the process that is
    // answering, which is the one that matters when two hosts are running
    // different builds.
    mesh = await startMesh({ withHttp: false });
    const health = await (await fetch(`${mesh.hub.url}/health`)).json();
    expect(health.agent_mesh_spec).toBe(specVersion());
    expect(health.agent_mesh_spec).not.toBe(health.version);
  }, 20_000);
});

/**
 * Every `code:` these two services put in a body, from source.
 *
 * **Both quote styles, and this is the whole point.** The scan matched only
 * `code: "X"` for as long as it existed, and `main.ts` writes single quotes —
 * so four codes were emitted by the http service and named nowhere, with the
 * check green over all of them: `TYPE_EXISTS`, `TYPE_IN_USE`,
 * `AUDIT_AGENTS_UNAVAILABLE`, `AUDIT_READ_UNRECORDABLE`. Nothing was wrong
 * with the rule; the reader could not see half the file. It surfaced when a
 * refactor moved two of them into a file that happens to use double quotes,
 * which is luck rather than a process.
 *
 * **Test files are excluded.** A test that constructs an error carrying a
 * `code` is describing a case, not emitting one — an `ENOENT` fixture is not
 * this deployment's vocabulary.
 *
 * Read as text in a subprocess rather than imported, so a code emitted but
 * never exported still counts. Importing would make the scan the smaller of
 * two answers.
 */
function emittedCodes(): Set<string> {
  const proc = Bun.spawnSync([
    "grep", "-rhoE", "--include=*.ts", "--exclude=*.test.ts",
    `code: ['"][A-Z_]+['"]`,
    join(REPO_ROOT, "packages/hub/src"), join(REPO_ROOT, "packages/http/src"),
  ]);
  return new Set(
    [...new TextDecoder().decode(proc.stdout).matchAll(/code: ['"]([A-Z_]+)['"]/g)].map((m) => m[1]!),
  );
}

/**
 * Codes this repository's **http admin surface** emits that the contract does
 * not name, listed one by one rather than matched by a pattern.
 *
 * They are not JSON-RPC `error.data.code`: nothing on the mesh wire carries
 * them, and a client pinning a contracts tag never sees one. They are REST
 * refusals an operator console switches on — which is the same shape
 * `PROVISION_ERROR` (§ 10.1) already has its own constant for, and the reason
 * that carve-out exists.
 *
 * **This is a gap, not a decision.** Whether they belong in
 * `agent-mesh-contracts` under a third constant is open — see
 * `docs/open-questions.md` — and answering it means cutting a contracts tag,
 * which is not this repository's to do alone. Written out by name so a fifth
 * one cannot join them quietly: adding a code here is a line in a diff with
 * this comment above it.
 */
const HTTP_ADMIN_ONLY = new Set([
  "TYPE_EXISTS",                // POST /api/v1/admin/agent-types, § 10.3
  "TYPE_IN_USE",                // DELETE the same, § 10.3
  "AUDIT_AGENTS_UNAVAILABLE",   // GET /api/v1/admin/chat-audits/agents, D-736
  "AUDIT_READ_UNRECORDABLE",    // any content read whose record failed, § 11.0.1
  "LAST_GRANTOR",               // DELETE /api/v1/admin/grants, § 11.3
  "PROTECTED_ACCOUNT",          // DELETE the same, D-746
]);

/**
 * The build table's own summary, counted rather than asserted in prose.
 *
 * The paragraph above that table said "most are not implemented — the shipped
 * build implements 0.1" while the table underneath it filled up with **yes**,
 * one row at a time. Nothing made the sentence false in a way a reader could
 * see: each row that changed made it more wrong, and a reader skimming takes
 * the sentence, not the table.
 *
 * Counting is the only thing that would have caught it, and it costs one test.
 */
describe("the 0.2 build table says what it contains", () => {
  const SPEC = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");

  /** Every `| § | Change | Built |` row, as its built-or-not verdict. */
  function rows(): boolean[] {
    const table = /\| § \| Change \| Built \|\n\|[^\n]*\|\n([\s\S]*?)\n\n/.exec(SPEC);
    if (!table) throw new Error("SPEC.md's 0.2 build table moved or was renamed");
    return table[1]!
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) => {
        // The last cell, which is the verdict. Splitting on the pipe leaves an
        // empty string after the trailing one, so the verdict is second from
        // the end.
        const cells = line.split("|").map((c) => c.trim());
        return /^(?:\*\*)?yes\b/.test(cells[cells.length - 2] ?? "");
      });
  }

  test("the table is still there to count", () => {
    // A pattern that went stale would agree with any claim made about it.
    expect(rows().length).toBeGreaterThan(10);
  });

  test("the paragraph's count is the table's count", () => {
    const built = rows().filter(Boolean).length;
    const total = rows().length;
    const claim = /\*\*(\d+) of the (\d+) rows below are built\*\*/.exec(SPEC);
    expect(claim, "the introduction no longer states how many rows are built").not.toBeNull();
    expect({ built: Number(claim![1]), total: Number(claim![2]) }).toEqual({ built, total });
  });

  test("what is not built is said to be somewhere else, not missing", () => {
    const unbuilt = rows().length - rows().filter(Boolean).length;
    expect(SPEC).toContain("are lane components");
    // The claim under the table names them; if the count changes, that
    // paragraph is what a reader checks next.
    expect({ unbuilt }).toEqual({ unbuilt: 2 });
  });
});

describe("the error vocabulary is complete", () => {
  test("every data.code the services emit has a name in contracts", async () => {
    // The direction that goes wrong. A hub can start emitting a discriminator
    // and nothing notices the contract does not name it — which is exactly how
    // `-32000` reached a client that had to hard-code its own constant to
    // handle it, and how `ERROR_CLASS` came to have no entry for that code.
    const { ERROR_DATA_CODE } = await import("@agent-mesh/contracts");

    const emitted = emittedCodes();
    expect(emitted.size).toBeGreaterThan(5);

    // `PROVISION_ERROR` covers the REST provisioning surface (§ 10.1), which is
    // not a JSON-RPC `error.data.code` and has its own constant.
    const { PROVISION_ERROR } = await import("@agent-mesh/contracts");
    const elsewhere = new Set(Object.values(PROVISION_ERROR as Record<string, string>));

    const unnamed = [...emitted].filter(
      (code) =>
        !Object.hasOwn(ERROR_DATA_CODE, code) &&
        !elsewhere.has(code) &&
        !HTTP_ADMIN_ONLY.has(code),
    );
    expect(unnamed).toEqual([]);
  });

  test("no name in the vocabulary is one nothing emits", () => {
    // The other direction: a code kept in the contract after the hub stopped
    // sending it is a branch a client maintains forever for a case that cannot
    // happen.
    const { ERROR_DATA_CODE } = require("@agent-mesh/contracts");
    const emitted = emittedCodes();
    const stale = Object.keys(ERROR_DATA_CODE).filter((code) => !emitted.has(code));
    expect(stale).toEqual([]);
  });
});

describe("every code the hub emits is classified", () => {
  test("the hub's own error constants all resolve to a class", async () => {
    // The direction the contract cannot check: contracts knows its tables
    // agree with themselves, and only this repository knows which codes the
    // hub actually puts on the wire.
    const { errorClass, ERROR_CLASS } = await import("@agent-mesh/contracts");

    const proc = Bun.spawnSync([
      // `[-]` rather than a leading `-`, which grep reads as an option.
      "grep", "-rhoE", "--include=*.ts", "[-]32[0-9]{3}",
      join(REPO_ROOT, "packages/hub/src"),
    ]);
    const emitted = new Set(
      new TextDecoder().decode(proc.stdout).trim().split("\n").map(Number).filter(Boolean),
    );
    expect(emitted.size).toBeGreaterThan(8);

    // `-32700`/`-32603` are JSON-RPC's own; `-32042` is retired and burned —
    // `RETIRED_AUDIT_SEQUENCE_CONFLICT` in `packages/hub/src/rpc/audit.ts` is
    // the tombstone that reserves it. Written out rather than imported: this
    // test reads the hub as text, in a subprocess, so that a code emitted but
    // never exported still counts. Importing it would pull the module's own
    // startup in and make the scan the smaller of two answers.
    const jsonRpcReserved = new Set([-32700, -32600, -32601, -32603]);
    const unclassified = [...emitted].filter(
      (code) => code !== -32042 && !jsonRpcReserved.has(code) && !Object.hasOwn(ERROR_CLASS, code),
    );
    expect(unclassified).toEqual([]);

    // And every emitted code resolves without reaching the caller's fallback —
    // the fallback answers a version skew, and this build is not skewed with
    // itself. Both spellings, so a code classified only by accident of the
    // fallback would show up.
    for (const code of emitted) {
      if (code === -32042 || jsonRpcReserved.has(code)) continue;
      expect(errorClass(code, "transient"), `class for ${code}`).toBe(
        errorClass(code, "permanent"),
      );
    }
  });
});

describe("the services stay inside the reserved band", () => {
  test("every code the hub emits is one this contract may allocate", async () => {
    // The contract can only check its own tables. Whether a *service* invents a
    // number outside the band is visible here and nowhere else — and inventing
    // one does not fail, it silently overlaps whatever a neighbouring protocol
    // put there (SPEC § 8).
    const { isMeshErrorCode, JSON_RPC_PREDEFINED } = await import("@agent-mesh/contracts");

    const proc = Bun.spawnSync([
      "grep", "-rhoE", "--include=*.ts", "[-]32[0-9]{3}",
      join(REPO_ROOT, "packages/hub/src"),
      join(REPO_ROOT, "packages/http/src"),
      join(REPO_ROOT, "packages/self-reminder/src"),
    ]);
    const emitted = new Set(
      new TextDecoder().decode(proc.stdout).trim().split("\n").map(Number).filter(Boolean),
    );
    expect(emitted.size).toBeGreaterThan(8);

    const predefined = new Set<number>(JSON_RPC_PREDEFINED);
    const outside = [...emitted].filter(
      (code) => !predefined.has(code) && !isMeshErrorCode(code),
    );
    expect(outside).toEqual([]);
  });
});
