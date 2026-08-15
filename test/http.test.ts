/**
 * HTTP integration — auth gates, the server-rendered pages, and the pair
 * finding each other.
 *
 * The page assertions exist because the pages were moved out of the route file
 * into `ui/` modules. Nothing about a template literal fails to compile when it
 * ends up in the wrong module or loses a binding it closed over; it fails when
 * someone loads it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { loginAsAdmin, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  adminCookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

const get = (path: string, cookie?: string) =>
  fetch(`${mesh.http.url}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });

describe("health", () => {
  test("reports version and uptime without authentication", async () => {
    const body = await (await get("/api/v1/health")).json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("authentication gates", () => {
  test("an API route without a session is 401, not a redirect", async () => {
    expect((await get("/api/v1/agents")).status).toBe(401);
    expect((await get("/api/v1/messages/someone")).status).toBe(401);
  });

  test("a page without a session redirects", async () => {
    expect((await get("/admin")).status).toBe(302);
    expect((await get("/chat")).status).toBe(302);
  });

  test("local login issues a session that /auth/me accepts", async () => {
    const me = await (await get("/auth/me", adminCookie)).json();
    expect(me).toMatchObject({ github_login: "admin", role: "admin" });
  });

  test("a bad password does not issue one", async () => {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=wrong",
      redirect: "manual",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("server-rendered pages", () => {
  test("the landing page renders", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Agent Mesh v2");
  });

  test("the landing page shows an error only when the query asks for one", async () => {
    expect(await (await get("/?error=invalid")).text()).toContain("Invalid username or password");
    expect(await (await get("/?error=missing")).text()).toContain("Username and password are required");
    expect(await (await get("/")).text()).not.toContain("Invalid username or password");
  });

  test("the admin console renders with its panels for an admin", async () => {
    const html = await (await get("/admin", adminCookie)).text();
    expect(html).toContain("Agent Mesh - Admin");
    // The three tabs the page is built around.
    expect(html).toContain("ai-usage-summary");
    expect(html).toContain("chat-audits");
  });

  test("the chat page carries its client script", async () => {
    const html = await (await get("/chat", adminCookie)).text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("renderMessages");
  });

  test("an unknown agent id renders the not-found page rather than erroring", async () => {
    const res = await get("/chat/no-such-agent", adminCookie);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<!DOCTYPE html>");
  });
});

describe("PWA assets", () => {
  test("manifest, service worker and icons all serve", async () => {
    const manifest = await get("/manifest.json");
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).name).toBeTruthy();

    const sw = await get("/sw.js");
    expect(sw.status).toBe(200);
    // Versioned per process start, which is what busts the cache on deploy.
    expect(await sw.text()).toContain("CACHE_VERSION");

    expect((await get("/icon-192.svg")).status).toBe(200);
    expect((await get("/icon-512.svg")).status).toBe(200);
  });

  test("the VAPID key endpoint answers even when no key is configured", async () => {
    const res = await get("/api/v1/push/vapid-key");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("publicKey");
  });
});

describe("agent registry", () => {
  test("starts empty and is this service's own list, not the hub's", async () => {
    // Provisioning on the hub does not populate the http registry: they are
    // different tables answering different questions (SPEC § 9.1).
    await provision(mesh.hub, "hub-only-agent", "service");
    const body = await (await get("/api/v1/agents", adminCookie)).json();
    expect(body.agents.map((a: any) => a.id)).not.toContain("hub-only-agent");
  });

  test("rejects a message to an agent it does not know", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ to: "not-in-registry", text: "hello" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("known_agents");
  });
});

describe("hub connection", () => {
  test("the http server connects to the hub as its own identity", async () => {
    // It joins as `http-server`, which the bootstrap script provisions in a
    // real deployment; here we just assert it got as far as trying.
    await Bun.sleep(300);
    expect(mesh.http.output()).toContain("hub");
  });
});

/**
 * SPEC § 10.3 — a person holds a mesh identity, like any other participant.
 *
 * Before this they existed only in `agent-mesh.db:agent_registry` and as a
 * string in the `proxy_for` list. The hub routed their messages and stored
 * their name in `messages.from_agent` without any record that the name
 * belonged to anyone.
 */
describe("people are mesh participants", () => {
  const httpDb = () => new Database(join(mesh.stateDir, "agent-mesh.db"));
  const agentsDb = () => new Database(join(mesh.stateDir, "agents.db"), { readonly: true });

  /** Pending rows are normally written by the OAuth callback. */
  const requestAccess = (login: string) => {
    const db = httpDb();
    db.prepare(
      `INSERT OR REPLACE INTO pending_approvals (github_login, github_id, status) VALUES (?, ?, 'pending')`,
    ).run(login, Math.floor(Math.random() * 1e6));
    db.close();
  };

  const approve = (login: string) =>
    fetch(`${mesh.http.url}/api/v1/admin/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ github_login: login }),
    });

  const meshIdentity = (identity: string) => {
    const db = agentsDb();
    const row = db.prepare(
      `SELECT identity, type FROM agents WHERE identity = ?`,
    ).get(identity) as { identity: string; type: string | null } | undefined;
    db.close();
    return row ?? null;
  };

  test("human is a seeded type the hub accepts", async () => {
    expect((await provision(mesh.hub, "typed-person", "human")).status).toBe(201);
  });

  test("approving a person registers them on the mesh as type human", async () => {
    requestAccess("new-person");
    expect((await approve("new-person")).status).toBe(200);

    expect(meshIdentity("new-person")).toEqual({ identity: "new-person", type: "human" });

    // And the http-side registry still has them, which is a different question
    // (architecture.md § 2) — this one lists who the web UI shows.
    const db = httpDb();
    const registry = db.prepare(
      `SELECT type, approved FROM agent_registry WHERE id = 'new-person'`,
    ).get() as { type: string; approved: number };
    db.close();
    expect(registry).toEqual({ type: "user", approved: 1 });
  });

  test("approving twice changes nothing", async () => {
    requestAccess("twice-person");
    await approve("twice-person");
    requestAccess("twice-person");
    expect((await approve("twice-person")).status).toBe(200);
    expect(meshIdentity("twice-person")).toEqual({ identity: "twice-person", type: "human" });
  });

  test("an uppercase login registers verbatim", async () => {
    // GitHub permits uppercase and 0.1's kebab-case rule excluded it, which
    // excluded the person. § 10.1 now takes the login as it is — and MUST, since
    // the same string is what this server sends as `from` (§ 8.2). Normalising
    // one half would split it from the other.
    requestAccess("MixedCase");
    expect((await approve("MixedCase")).status).toBe(200);
    expect(meshIdentity("MixedCase")).toEqual({ identity: "MixedCase", type: "human" });
    // Case-sensitive: the lowercase spelling is a different identity, and no
    // row was created for it.
    expect(meshIdentity("mixedcase")).toBeNull();
  });

  test("a login the rule still rejects is approved and reported", async () => {
    // The rule loosened, it did not disappear: an identity begins with a letter
    // or digit. Such a person stays a web user and is logged, not mangled to fit.
    requestAccess("-leading-hyphen");
    expect((await approve("-leading-hyphen")).status).toBe(200);
    expect(meshIdentity("-leading-hyphen")).toBeNull();
  });
});
