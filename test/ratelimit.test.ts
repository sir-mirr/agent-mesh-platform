/**
 * The rate limits are actually wired to the routes (SPEC § 14).
 *
 * **The gap this closes.** `packages/hub/src/ratelimit.test.ts` covers the token
 * bucket thoroughly — refill, burst, sweep, `retryAfter` never zero — and nothing
 * covered the routes *using* it. A sweep that disabled both limiters entirely,
 * replacing each `take()` with a constant allow, produced zero test failures
 * across 555 tests.
 *
 * Arithmetic that nothing calls is arithmetic. This is the other half.
 *
 * ## Why the limits are lowered here rather than exercised as configured
 *
 * The defaults are deliberately generous — 300 burst and 600/minute on
 * provisioning — because a limit that fires during ordinary onboarding is a
 * limit somebody switches off, and the first numbers chosen were low enough to
 * break fifty-eight tests. Reaching those defaults honestly would mean three
 * hundred requests per assertion.
 *
 * So the mesh is started with the limits set to something a test can reach, and
 * what is checked is that the route consults them at all and reports the refusal
 * § 14 specifies. The *values* are the deployment's business; the wiring is the
 * contract's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID, sign as edSign } from "node:crypto";
import { formatRestAuthorization, restSignaturePreimage } from "@agent-mesh/contracts";
import { loginAsAdmin, newKeyPair, startMesh, type KeyPair, type Mesh } from "./harness";

/**
 * **One mesh per limiter under test**, because they are not independent from a
 * test's point of view: reaching the provisioning limit leaves nothing with
 * which to register the identities the signed tests need, and the first draft
 * of this file did exactly that. Its own comment predicted it.
 *
 * So each mesh tightens the limiter it is about and leaves the other generous.
 * A tightened limiter is the subject; a tightened bystander is a flake.
 */
let provisionMesh: Mesh;
let signedMesh: Mesh;
let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  [provisionMesh, signedMesh] = await Promise.all([
    startMesh({
      env: {
        AGENT_MESH_PROVISION_BURST: "2",
        AGENT_MESH_PROVISION_PER_MINUTE: "1",
      },
    }),
    startMesh({
      env: {
        // Two, refilling slowly enough that the next request inside a test
        // cannot be rescued by the clock.
        AGENT_MESH_SIGNED_BURST: "2",
        AGENT_MESH_SIGNED_PER_MINUTE: "1",
      },
    }),
  ]);
  mesh = signedMesh;
  cookie = await loginAsAdmin(signedMesh.http);
});

afterAll(() => {
  provisionMesh?.stop();
  signedMesh?.stop();
});

const provision = (identity: string) =>
  fetch(`${provisionMesh.hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type: "service" }),
  });

describe("the unauthenticated provisioning route (§ 14)", () => {
  test("refuses past the burst, and says how long to wait", async () => {
    // Distinct identities: this is about the *rate*, not about re-registering
    // the same name, which the supersession rule handles separately.
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push((await provision(`rl-${i}`)).status);

    expect(seen, `every request was served: ${seen.join(", ")}`).toContain(429);

    const refused = await provision("rl-after");
    expect(refused.status).toBe(429);

    const body = await refused.json();
    expect(body.code).toBe("RATE_LIMITED");
    // § 14 requires a caller be told when to come back. Zero would invite the
    // tight loop the limit exists to stop, which `retryAfter` rounds up to
    // avoid — asserted here because that rounding is only reachable through a
    // route.
    expect(body.retry_after).toBeGreaterThan(0);
    expect(refused.headers.get("retry-after")).toBe(String(body.retry_after));
  });
});

describe("the signed routes (§ 14)", () => {
  /** A signed REST call, built the way a participant must build one. */
  async function signedGet(kp: KeyPair, path: string): Promise<Response> {
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(
        null,
        Buffer.from(
          restSignaturePreimage({
            method: "GET",
            path,
            kid: kp.fingerprint,
            nonce,
            iat,
            bodySha256: "",
          }),
        ),
        kp.privateKey,
      ),
    ).toString("base64url");
    return fetch(`${mesh.hub.url}${path}`, {
      headers: {
        authorization: formatRestAuthorization({ kid: kp.fingerprint, nonce, iat, signature }),
      },
    });
  }

  test("refuses past the burst, keyed on the identity", async () => {
    const key = newKeyPair();
    const created = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "rl-signed", type: "ai-claude", public_key: key.publicKey }),
    });
    // This mesh leaves provisioning generous on purpose, so a refusal here is
    // not this test's subject and is worth failing loudly on rather than
    // reading as the signed limit firing early.
    expect(created.status, `provisioning was itself refused: ${created.status}`).toBe(201);

    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint: key.fingerprint }),
    });

    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push((await signedGet(key, "/api/v1/mailbox/out")).status);

    expect(seen, `every signed request was served: ${seen.join(", ")}`).toContain(429);

    const refused = await signedGet(key, "/api/v1/mailbox/out");
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.code ?? body.data?.code).toBe("RATE_LIMITED");
  });

  test("a second identity has its own budget", async () => {
    // The reason § 14 keys signed routes on the identity rather than the
    // address: one lane misbehaving must not exhaust everything sharing its
    // NAT. Without this, a single shared bucket passes the test above.
    const other = newKeyPair();
    const created = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "rl-other", type: "ai-claude", public_key: other.publicKey }),
    });
    expect(created.status, `provisioning was itself refused: ${created.status}`).toBe(201);

    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint: other.fingerprint }),
    });

    // The previous test left `rl-signed` exhausted. This identity has never
    // called, so its first request must be served.
    expect((await signedGet(other, "/api/v1/mailbox/out")).status).toBe(200);
  });
});
