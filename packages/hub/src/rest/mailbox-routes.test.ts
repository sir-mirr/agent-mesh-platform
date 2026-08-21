/**
 * What the signed mailbox surface answers before it does any work (§ 9.2.1).
 *
 * `rest/mailbox.ts` read 32.70%. `mailbox-path.test.ts` beside it settles *which
 * paths* this module owns; this settles what each of them says to a caller who
 * has not signed, has signed for the wrong verb, or has sent a body the route
 * cannot parse. `test/mailbox-routes.test.ts` drives the same surface over a
 * real mesh and is the right place for the three rules that make these routes
 * different from a mailer — but a suite that needs a running hub is a suite
 * nobody runs early, and none of what is below needs one.
 *
 * The run's shared state directory, unique identities, no cleanup: a file that
 * removes a directory `db.ts`'s `const` handles still point at leaves every
 * later caller with `SQLITE_IOERR`.
 */
import { describe, expect, test } from "bun:test";

import { formatRestAuthorization, restSignaturePreimage } from "@agent-mesh/contracts";
import { keys } from "@agent-mesh/store";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";

import { agentsDb } from "../db";
import { handleMailboxRoute, type MailboxRequest } from "./mailbox";

let n = 0;
const nextId = (p: string) => `rest-${p}-${++n}-${process.pid}`;

/** An identity of a type that must sign, holding an approved key. */
function signer() {
  const type = "in-process-rest-signing";
  agentsDb.prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, 1)`).run(type);
  const identity = nextId("signer");
  agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, type);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  const { fingerprint } = keys.proposeKey(agentsDb, identity, raw, "in-process-test");
  keys.approveKey(agentsDb, fingerprint, "in-process-test");
  return { identity, privateKey, fingerprint };
}

/** A request built the way a client must build one, or deliberately not. */
function request(
  method: string,
  path: string,
  body = "",
  auth: ReturnType<typeof signer> | null = null,
): MailboxRequest {
  const [pathname, search] = path.split("?");
  let authorization: string | null = null;
  if (auth) {
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    // The digest of the body, hex, and the empty string when there is none —
    // the preimage covers what was sent, not a re-serialisation of it.
    const bodySha256 = body ? createHash("sha256").update(body, "utf8").digest("hex") : "";
    const preimage = restSignaturePreimage({
      method,
      path,
      kid: auth.fingerprint,
      nonce,
      iat,
      bodySha256,
    });
    authorization = formatRestAuthorization({
      kid: auth.fingerprint,
      nonce,
      iat,
      signature: edSign(null, Buffer.from(preimage), auth.privateKey).toString("base64url"),
    });
  }
  return {
    method,
    path,
    pathname: pathname!,
    search: search ? `?${search}` : "",
    authorization,
    body,
  };
}

const answer = async (req: MailboxRequest) => {
  const res = handleMailboxRoute(req);
  expect(res).not.toBeNull();
  return { status: res!.status, body: (await res!.json()) as Record<string, any> };
};

const OWNED = [
  ["POST", "/api/v1/mailbox/in"],
  ["GET", "/api/v1/mailbox/history?peer=x"],
  ["GET", "/api/v1/mailbox/out"],
  ["DELETE", "/api/v1/mailbox/out/01J000"],
] as const;

describe("the unsigned route beside the signed ones", () => {
  /**
   * Unsigned deliberately: the values matter most while a caller cannot yet
   * sign, so a `pending` key can read the lease window it needs to size its
   * retry loop before an operator has approved anything.
   */
  test("capabilities answers without a signature", async () => {
    const { status, body } = await answer(request("GET", "/api/v1/capabilities"));
    expect(status).toBe(200);
    expect(typeof body.mailbox?.receive_lease_seconds).toBe("number");
    expect(typeof body.mailbox?.dormancy_seconds).toBe("number");
    expect(typeof body.audit?.schema_version_max).toBe("number");
    // The address this hub hands out for uploads, which it cannot derive: http
    // connects to the hub, never the reverse.
    expect(typeof body.audit?.blob_base_url).toBe("string");
    // The running deployment's mode, not the default's — reporting the constant
    // would tell every caller `socket` however the process was configured.
    expect(typeof body.surface?.observed_source).toBe("string");
    // Which checkout is answering (§ 7). An instance served a branch ninety-three
    // commits behind `main` and the only way to tell was to notice missing routes.
    expect(body.platform).toBeDefined();
  });

  test("and refuses any other verb on it, naming the one it takes", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const { status, body } = await answer(request(method, "/api/v1/capabilities"));
      expect(status).toBe(405);
      expect(body.error).toContain("use GET");
    }
  });
});

describe("the signed surface refuses", () => {
  test("every owned path when nothing is signed", async () => {
    for (const [method, path] of OWNED) {
      const { status, body } = await answer(request(method, path));
      expect(status).toBe(401);
      expect(body.error).toContain("must be signed");
    }
  });

  test("an authorization header it cannot parse", async () => {
    const req = request("GET", "/api/v1/mailbox/out");
    const { status, body } = await answer({ ...req, authorization: "Bearer nope" });
    expect(status).toBe(401);
    expect(body.error).toContain("malformed");
  });

  /**
   * Each path takes the verbs it takes, and the refusal names them. Taking
   * delivery is a `POST` because it acts — it leases, settles and audits — and
   * a `GET` would invite every layer that treats `GET` as safe to retry it and
   * silently consume a lease.
   */
  test("a signed request for a verb the path does not take", async () => {
    const s = signer();
    const cases: Array<[string, string, string]> = [
      ["GET", "/api/v1/mailbox/in", "use POST"],
      ["POST", "/api/v1/mailbox/history?peer=x", "use GET"],
      ["DELETE", "/api/v1/mailbox/out", "use GET or POST"],
      ["GET", "/api/v1/mailbox/out/01J000", "use DELETE"],
    ];
    for (const [method, path, expected] of cases) {
      const { status, body } = await answer(request(method, path, "", s));
      expect(status).toBe(405);
      expect(body.error).toContain(expected);
    }
  });

  test("a body the route cannot parse, with the rpc code beside the status", async () => {
    const s = signer();
    const { status, body } = await answer(request("POST", "/api/v1/mailbox/in", "{not json", s));
    expect(status).toBe(400);
    expect(body.error).toContain("invalid JSON");
    // The status cannot carry the retry policy; `ERROR_CLASS` is keyed on the
    // number, so it travels in the body.
    expect(typeof body.rpc_code).toBe("number");
  });

  test("a history request with no peer", async () => {
    const s = signer();
    const { status, body } = await answer(request("GET", "/api/v1/mailbox/history", "", s));
    expect(status).toBe(400);
    expect(body.error).toContain("peer is required");
  });

  /**
   * A recall is scoped to the sender. Answering "not found" for a message that
   * exists but belongs to somebody else is the same sentence as for one that
   * does not exist, on purpose — the alternative tells a caller whether an id
   * they guessed is real.
   */
  test("a recall of a message this sender never sent", async () => {
    const s = signer();
    const { status, body } = await answer(request("DELETE", `/api/v1/mailbox/out/${nextId("ghost")}`, "", s));
    expect(status).toBe(404);
    expect(body.error).toContain("no such message from this sender");
  });
});

describe("a path this module does not own", () => {
  test("is answered with null so the dispatcher can fall through", () => {
    for (const pathname of ["/api/v1/mailboxfoo", "/api/v1/mailbox", "/health"]) {
      expect(handleMailboxRoute({ ...request("GET", pathname) })).toBeNull();
    }
  });
});
