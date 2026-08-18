/**
 * How much each tenant received (SPEC § 11.4).
 *
 * The owner's rule is that traffic belongs to the **recipient's** tenant. That
 * is total rather than merely chosen: every message has exactly one recipient,
 * so every message lands in exactly one tenant — cross-tenant traffic included.
 * A sender rule would leave traffic that *arrived* in a tenant missing from that
 * tenant's view, which is the reading an operator is actually misled by, and it
 * is the case this file spends most of its length on.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID, sign as edSign } from "node:crypto";
import { formatRestAuthorization, restSignaturePreimage } from "@agent-mesh/contracts";
import { callHttp, loginAsAdmin, newKeyPair, openTestDb, startMesh, type KeyPair, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;
const keys = new Map<string, KeyPair>();

async function agent(identity: string, tenant?: string): Promise<void> {
  const k = newKeyPair();
  keys.set(identity, k);
  await fetch(`${mesh.hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type: "ai-claude", public_key: k.publicKey }),
  });
  await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint: k.fingerprint }),
  });
  if (tenant) {
    // No route assigns tenancy yet — the column is what § 11.4 needed and
    // whoever provisions decides it. Written directly so this file tests the
    // attribution rule rather than a route that does not exist.
    const db = openTestDb(`${mesh.stateDir}/agents.db`);
    db.prepare(`UPDATE agents SET tenant = ? WHERE identity = ?`).run(tenant, identity);
    db.close();
  }
}

const send = (from: string, to: string, content: string) =>
  callHttp(mesh.hub, { kid: keys.get(from)!.fingerprint, privateKey: keys.get(from)!.privateKey },
    "mesh.send", { to, content });

const stats = async (): Promise<any> =>
  (await (await fetch(`${mesh.http.url}/api/v1/admin/tenants`, { headers: { cookie } })).json());

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
  await agent("ts-acme-a", "acme");
  await agent("ts-acme-b", "acme");
  await agent("ts-nova-a", "nova");
});
afterAll(() => mesh?.stop());

describe("attribution", () => {
  test("traffic lands in the recipient's tenant", async () => {
    await send("ts-acme-a", "ts-acme-b", "within acme");
    const body = await stats();
    expect(body.ok).toBe(true);
    expect(body.tenants.find((t: any) => t.tenant === "acme")?.received).toBe(1);
  });

  test("a cross-tenant message counts once, for the recipient", async () => {
    // **The rule's whole point.** Under a sender rule this would land in acme
    // and never appear in nova's view — traffic that arrived somewhere and is
    // reported nowhere near it.
    await send("ts-acme-a", "ts-nova-a", "across");
    const body = await stats();
    expect(body.tenants.find((t: any) => t.tenant === "nova")?.received).toBe(1);
    expect(body.tenants.find((t: any) => t.tenant === "acme")?.received).toBe(1);
  });

  test("an identity nobody assigned counts as default", async () => {
    await agent("ts-unassigned");
    await send("ts-acme-a", "ts-unassigned", "unassigned");
    const body = await stats();
    expect(body.tenants.find((t: any) => t.tenant === "default")?.received).toBe(1);
  });
});

describe("what the row records", () => {
  test("the transport is kept, so mailbox and mesh are distinguishable", async () => {
    const body = await stats();
    const acme = body.tenants.find((t: any) => t.tenant === "acme");
    // Everything above went over /api/v1/rpc, which is mesh.
    expect(acme.via_mailbox).toBe(0);
  });

  test("a mailbox send is counted as one", async () => {
    // **The half that was asserted and never produced.** The test above pinned
    // `via_mailbox: 0` without a single message having taken that route, so the
    // column could have been recording anything at all and still satisfied it.
    // A zero nobody can make non-zero is not evidence about a counter.
    const k = keys.get("ts-acme-a")!;
    const path = "/api/v1/mailbox/out";
    const payload = JSON.stringify({ to: "ts-acme-b", content: "by mail" });
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(
        null,
        Buffer.from(
          restSignaturePreimage({
            method: "POST",
            path,
            kid: k.fingerprint,
            nonce,
            iat,
            bodySha256: createHash("sha256").update(payload, "utf8").digest("hex"),
          }),
        ),
        k.privateKey,
      ),
    ).toString("base64url");

    const res = await fetch(`${mesh.hub.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: formatRestAuthorization({ kid: k.fingerprint, nonce, iat, signature }),
      },
      body: payload,
    });
    expect(res.status, `the mailbox route refused: ${res.status}`).toBe(200);

    const acme = (await stats()).tenants.find((t: any) => t.tenant === "acme");
    expect(acme.via_mailbox, "a mailbox send was not recorded as one").toBe(1);
  });

  test("no content and no size are exposed", async () => {
    // § 11.0 draws the platform operator's line at metadata, and a statistics
    // table is exactly where content arrives under the name "just a length".
    const raw = JSON.stringify(await stats());
    expect(raw).not.toContain("within acme");
    expect(raw).not.toMatch(/"(content|bytes|size|length)"/);
  });
});

describe("the gate", () => {
  test("no session is refused", async () => {
    expect((await fetch(`${mesh.http.url}/api/v1/admin/tenants`)).status).toBe(401);
  });
});
