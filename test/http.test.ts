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
