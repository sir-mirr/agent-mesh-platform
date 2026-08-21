/**
 * Everything `POST /api/v1/messages` refuses, and what it says when it does.
 *
 * The send route is the one place a person's text enters the mesh, and every
 * gate in front of it answers a different question:
 *
 * - **Authenticated** — is there a caller at all.
 * - **Approved** — § 9.2a. An account waiting on an admin is not a caller who
 *   got a credential wrong, so it is `403` with a reason, not `401`.
 * - **Well-formed** — `to` and `text`, each named in its own refusal, because
 *   a client told only "bad request" has to guess which field it dropped.
 * - **Authorised** — § 11. The policy list is per-user; a member with no
 *   policy may message nobody, and the default is refusal rather than the
 *   wildcard the first user is granted at install.
 * - **Addressable** — the target is in `agent_registry`, and the `404` carries
 *   `known_agents` so a caller that mistyped a name can see the real ones
 *   without a second round trip.
 *
 * Order matters and is asserted: a pending account is refused before its JSON
 * is parsed, and an unauthorised sender is refused before the registry is
 * consulted — otherwise the 404 tells someone with no grant at all which
 * agents exist.
 *
 * The last case sweeps the neighbouring reads: the approval gate is copied
 * into every route on this surface, and a copy is how one of them comes to
 * answer while the rest refuse.
 *
 * This file owns the `snd-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "send-refusals-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getDb } = await import("./db");
const { signJwt } = await import("./auth");

let n = 0;
const uniq = (p: string) => `snd-${p}-${++n}-${process.pid}`;

async function jwtFor(login: string, github_id: number, role = "member") {
  return signJwt({ github_id, github_login: login, role });
}

/** A member whose account is still waiting on an admin. */
async function pending() {
  const login = uniq("waiting");
  const user = upsertUser(1_020_000 + n, login);
  createPendingApproval(login, user.github_id);
  return { login, jwt: await jwtFor(login, user.github_id) };
}

/** An approved member. `allow` names the agents its policy admits. */
async function member(...allow: string[]) {
  const login = uniq("member");
  const user = upsertUser(1_020_000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  const db = getDb();
  for (const agent of allow) {
    db.prepare("INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, ?)")
      .run(login, agent);
  }
  return { login, jwt: await jwtFor(login, user.github_id) };
}

function registerAgent(id: string) {
  getDb().prepare(
    "INSERT OR IGNORE INTO agent_registry (id, name, channel, type, approved) VALUES (?, ?, 'mesh', 'agent', 1)",
  ).run(id, id);
  return id;
}

const send = (jwt: string | null, body: unknown) =>
  app.fetch(new Request("http://snd-probe/api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt === null ? {} : { authorization: `Bearer ${jwt}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

describe("who may send", () => {
  test("refuses a caller carrying no token", async () => {
    const res = await send(null, { to: "anyone", text: "hello" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Authorization: Bearer");
  });

  /**
   * **`403`, not `401`.** The credential is good; the account is not yet
   * admitted. A caller told `401` goes looking for a better token, and there
   * is no token that helps — only an admin.
   */
  test("refuses an account still waiting on an admin, and does not call it a bad token", async () => {
    const who = await pending();
    const res = await send(who.jwt, { to: "anyone", text: "hello" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Account pending approval");
  });

  /** The approval gate runs before the body is parsed: unparseable stays 403. */
  test("refuses a pending account before it looks at the body", async () => {
    const who = await pending();
    expect((await send(who.jwt, "{ not json")).status).toBe(403);
  });
});

describe("what it will read", () => {
  test("refuses a body it cannot parse", async () => {
    const who = await member("*");
    const res = await send(who.jwt, "{ not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  /**
   * Each missing field is named. One "bad request" for both would leave the
   * client to guess, and the two are dropped by different bugs.
   */
  test("names the field it is missing, rather than refusing in general", async () => {
    const who = await member("*");
    for (const [body, field] of [
      [{ text: "hello" }, "to"],
      [{ to: "someone" }, "text"],
      [{ to: 7, text: "hello" }, "to"],
      [{ to: "someone", text: 7 }, "text"],
      [{ to: "someone", text: "" }, "text"],
    ] as const) {
      const res = await send(who.jwt, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(`"${field}"`);
    }
  });

  /** `file_path` is checked against the disk this process can see. */
  test("refuses an attachment path that is not there", async () => {
    const who = await member("*");
    const res = await send(who.jwt, {
      to: "someone", text: "hello", file_path: `/nonexistent/${uniq("file")}`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("File not found");
  });
});

describe("who may be sent to", () => {
  /** Refusal is the default. A member with no policy may message nobody. */
  test("refuses a member whose policy admits nobody", async () => {
    const who = await member();
    const target = registerAgent(uniq("agent"));
    const res = await send(who.jwt, { to: target, text: "hello" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(`not authorized to message agent "${target}"`);
  });

  /** A policy is for the agent it names, not for the next one along. */
  test("refuses a target the policy does not name", async () => {
    const allowed = registerAgent(uniq("allowed"));
    const other = registerAgent(uniq("other"));
    const who = await member(allowed);
    expect((await send(who.jwt, { to: other, text: "hello" })).status).toBe(403);
  });

  test("tells an authorised sender which agents exist, when the one named does not", async () => {
    const known = registerAgent(uniq("known"));
    const who = await member("*");
    const res = await send(who.jwt, { to: uniq("ghost"), text: "hello" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found in registry");
    expect(body.known_agents).toContain(known);
  });

  /**
   * **The registry is consulted after the policy, and the order is the
   * property.** `known_agents` is a list of every agent in the deployment; a
   * caller with no grant at all must not be able to read it by naming an agent
   * that does not exist.
   */
  test("does not name the registry to a sender who may message nobody", async () => {
    const who = await member();
    const res = await send(who.jwt, { to: uniq("ghost"), text: "hello" });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("known_agents");
  });
});

describe("the same gate, one route over", () => {
  /**
   * **Copied, not shared.** `isUserApproved` is called at the head of each
   * route rather than in one middleware, so the gate is only as good as the
   * least recently edited copy — and a route that forgot it does not fail, it
   * answers. Named individually because that is the failure: not "the gate is
   * broken" but "this one route has no gate".
   */
  test("every read on this surface refuses a pending account the same way", async () => {
    const who = await pending();
    for (const path of ["/api/v1/agents", "/api/v1/messages/somebody", "/api/v1/files"]) {
      const res = await app.fetch(new Request(`http://snd-probe${path}`, {
        headers: { authorization: `Bearer ${who.jwt}` },
      }));
      expect(`${path} ${res.status}`).toBe(`${path} 403`);
      expect((await res.json()).error).toBe("Account pending approval");
    }
  });
});
