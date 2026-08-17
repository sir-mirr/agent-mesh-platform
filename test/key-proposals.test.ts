/**
 * An operator is told when an agent asks to join (SPEC § 10.2.1).
 *
 * The flow starts on the agent's side and stops dead until a human compares a
 * fingerprint. Before this, learning that a key was waiting meant asking — from
 * a screen somebody had already opened, on a timer somebody had set. Nobody
 * looking meant nobody knew.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginAsAdmin, newKeyPair, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});
afterAll(() => mesh?.stop());

const register = (identity: string, publicKey: string) =>
  fetch(`${mesh.hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type: "ai-claude", public_key: publicKey }),
  });

/**
 * Read events off the stream until one names `identity`.
 *
 * **Never races the read.** The first version did — `Promise.race([read(),
 * sleep()])` — and abandoned the losing `read()` promise while it still held
 * the lock. The chunk then arrived into a promise nobody was looking at, and
 * the stream appeared to push nothing while the server log showed it pushing.
 * That cost more time than the feature.
 *
 * The deadline lives on the fetch instead, through an `AbortSignal`, so the
 * read loop is a plain loop and the only way out is data or abort.
 */
async function waitForProposal(res: Response, identity: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value);
      if (buffer.includes("event: key-proposed") && buffer.includes(identity)) return buffer;
    }
  } catch {
    // Aborted by the deadline. Whatever arrived is the answer, and an empty
    // one fails the assertion below with the buffer in the message.
    return buffer;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("the key-proposal stream", () => {
  test("pushes a proposal that arrives while an operator is watching", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/stream`, {
      headers: { cookie },
      signal: AbortSignal.timeout(8000),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const key = newKeyPair();
    // Registered *after* the stream is open, which is the case the stream is
    // for. What was already waiting is a snapshot, not an arrival.
    expect((await register("watched-agent", key.publicKey)).status).toBe(201);

    const body = await waitForProposal(res, "watched-agent");
    expect(body, "nothing was pushed").toContain("event: key-proposed");
    expect(body).toContain("watched-agent");
    expect(body).toContain(key.fingerprint);
    // § 10.2 decides by comparing a fingerprint against what the agent's own
    // operator reports out of band. Shipping the key to the screen invites
    // comparing it against itself, which attests to nothing.
    expect(body, "the public key was pushed to the browser").not.toContain(key.publicKey);
  });

  test("a session without key.approve is refused", async () => {
    // § 11: whoever is told about a decision is whoever can make it. A
    // notification reaching people who cannot act on it is one they learn to
    // close.
    expect((await fetch(`${mesh.http.url}/api/v1/admin/keys/stream`)).status).toBe(401);
  });
});
