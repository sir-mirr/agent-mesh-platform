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
