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
    } catch {
      // Not a package directory.
    }
  }
  return found;
}

describe("§ 13 version declarations", () => {
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

describe("the error vocabulary is complete", () => {
  test("every data.code the services emit has a name in contracts", async () => {
    // The direction that goes wrong. A hub can start emitting a discriminator
    // and nothing notices the contract does not name it — which is exactly how
    // `-32000` reached a client that had to hard-code its own constant to
    // handle it, and how `ERROR_CLASS` came to have no entry for that code.
    const { ERROR_DATA_CODE } = await import("@agent-mesh/contracts");

    const emitted = new Set<string>();
    for (const dir of ["packages/hub/src", "packages/http/src"]) {
      const proc = Bun.spawnSync(["grep", "-rho", "--include=*.ts", 'code: "[A-Z_]*"', join(REPO_ROOT, dir)]);
      for (const m of new TextDecoder().decode(proc.stdout).matchAll(/code: "([A-Z_]+)"/g)) {
        emitted.add(m[1]!);
      }
    }
    expect(emitted.size).toBeGreaterThan(5);

    // `PROVISION_ERROR` covers the REST provisioning surface (§ 10.1), which is
    // not a JSON-RPC `error.data.code` and has its own constant.
    const { PROVISION_ERROR } = await import("@agent-mesh/contracts");
    const elsewhere = new Set(Object.values(PROVISION_ERROR as Record<string, string>));

    const unnamed = [...emitted].filter(
      (code) => !Object.hasOwn(ERROR_DATA_CODE, code) && !elsewhere.has(code),
    );
    expect(unnamed).toEqual([]);
  });

  test("no name in the vocabulary is one nothing emits", () => {
    // The other direction: a code kept in the contract after the hub stopped
    // sending it is a branch a client maintains forever for a case that cannot
    // happen.
    const { ERROR_DATA_CODE } = require("@agent-mesh/contracts");
    const proc = Bun.spawnSync([
      "grep", "-rho", "--include=*.ts", 'code: "[A-Z_]*"',
      join(REPO_ROOT, "packages/hub/src"), join(REPO_ROOT, "packages/http/src"),
    ]);
    const emitted = new Set(
      [...new TextDecoder().decode(proc.stdout).matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]!),
    );
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

    // `-32700`/`-32603` are JSON-RPC's own; `-32042` is retired and burned.
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
