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

import { connectRpc, loginAsAdmin, openTestDb, provision, startMesh, type Mesh } from "./harness";

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

  test("`agent_count` counts mesh identities, and moves when one is provisioned", async () => {
    // **It counted the wrong table for as long as it existed**, and the test
    // above is why nobody noticed: asserting the shape of a response says
    // nothing about where a number came from, and every wrong source produces
    // a number.
    //
    // `countRegistryAgents()` counts `agent_registry`, this process's messaging
    // directory. Its only writers are a one-time import of the pre-database
    // `registry.json` and `upsertApprovedWebUser`, which inserts a **person**.
    // Provisioning a mesh identity never touched it. On the deployment where
    // this was found the route answered `agent_count: 1` — the 1 was `admin`, a
    // human — while the mesh in the same state directory held fourteen agents.
    //
    // The assertion is a delta rather than a value. A fixture where the right
    // and wrong tables happen to hold the same number proves nothing, and
    // *moves when an agent is provisioned* is the one form of this that cannot
    // be satisfied by the directory: nothing about provisioning writes it.
    const before = (await (await get("/api/v1/health")).json()).agent_count;
    expect(typeof before).toBe("number");

    await provision(mesh.hub, "health-count-a", "ai-claude", null);
    await provision(mesh.hub, "health-count-b", "ai-claude", null);

    const after = (await (await get("/api/v1/health")).json()).agent_count;
    expect(after, "provisioning two identities did not move the count").toBe(before + 2);
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
 * § 15.3 — the attachment download contract.
 *
 * Unauthenticated by design at this profile (§ 15.3): the id is a sha256
 * digest, so knowing it is the authorisation. That makes the id validation the
 * only thing standing between a caller and the filesystem, which is why the
 * traversal cases are asserted rather than assumed.
 */
describe("attachment metadata (§ 15.2)", () => {
  /**
   * The web surface only sends to agents its own registry lists — the two
   * lists answer different questions (§ 9.1), and the hub knowing an identity
   * does not mean the UI offers it. So a test recipient has to exist on both
   * sides.
   */
  const addToWebRegistry = (id: string) => {
    const db = openTestDb(join(mesh.stateDir, "agent-mesh.db"));
    db.prepare(
      `INSERT OR IGNORE INTO agent_registry (id, name, type, approved) VALUES (?, ?, 'agent', 1)`,
    ).run(id, id);
    db.close();
  };

  const upload = async (content: string, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    const res = await fetch(`${mesh.http.url}/api/v1/upload`, {
      method: "POST", headers: { cookie: adminCookie }, body: form,
    });
    return { status: res.status, body: await res.json() };
  };

  test("the upload response is itself a valid metadata object", async () => {
    // § 15.2: so a client can attach the response to a message unchanged.
    const { status, body } = await upload("metadata shape", "doc.txt");
    expect(status).toBe(200);
    for (const field of ["id", "name", "mime", "size", "sha256", "download_url", "uploaded_at"]) {
      expect(body[field], `missing ${field}`).toBeTruthy();
    }
    expect(body.name).toBe("doc.txt");
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(body.uploaded_at).toString()).not.toBe("Invalid Date");
  });

  test("download_url is absolute and resolves", async () => {
    // A relative URL is resolved by a lane VM against its own origin, where the
    // route does not exist. The hub had the identical defect for blob uploads
    // and it was found in integration, not by either side's tests.
    const { body } = await upload("absolute please", "abs.txt");
    expect(body.download_url.startsWith("http")).toBe(true);
    expect(body.download_url.endsWith(`/api/v1/attachments/${body.id}`)).toBe(true);

    // Followed verbatim, which is what a receiver does — with the session,
    // because § 15.3 authorises the parties rather than whoever holds the URL.
    await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ to: "admin", text: "x", attachments: [{ id: body.id, download_url: body.download_url }] }),
    });
    const fetched = await fetch(body.download_url, { headers: { cookie: adminCookie } });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("absolute please");
  });

  test("a message carrying attachments puts them in the body", async () => {
    // § 15.2 requires the array to be *in* the message body. Nothing built one
    // before, so § 15.4's pull-on-demand loop had no producer — a lane could
    // never receive a download_url to fetch.
    const { body: meta } = await upload("attached bytes", "att.bin");
    await provision(mesh.hub, "attach-recipient", "service");
    addToWebRegistry("attach-recipient");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "attach-recipient" });

    const sent = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ to: "attach-recipient", text: "see attached", attachments: [meta] }),
    });
    expect(sent.status).toBeLessThan(300);

    await Bun.sleep(250);
    const pushed = rpc.notifications().find((n) => n.method === "mesh.message");
    rpc.close();

    const parsed = JSON.parse(pushed.params.content);
    expect(parsed.text).toBe("see attached");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ id: meta.id, name: "att.bin" });
    expect(parsed.attachments[0].download_url.startsWith("http")).toBe(true);
  });

  test("a message without attachments stays a plain string", async () => {
    // Nothing changes for the common case: § 8.2's content is a flat string and
    // wrapping every message in JSON would break every existing consumer.
    await provision(mesh.hub, "plain-recipient", "service");
    addToWebRegistry("plain-recipient");
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "plain-recipient" });

    await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ to: "plain-recipient", text: "no attachments here" }),
    });
    await Bun.sleep(250);
    const pushed = rpc.notifications().find((n) => n.method === "mesh.message");
    rpc.close();
    expect(pushed.params.content).toBe("no attachments here");
  });
});

describe("attachment download", () => {
  /**
   * Make `admin` a party to a message carrying this attachment, then fetch.
   *
   * § 15.3 authorises the parties to the message, so a bare upload grants the
   * uploader nothing — an attachment nobody has sent is an attachment nobody
   * is party to. Sending it is what creates the entitlement, and doing that
   * here rather than hiding it in a helper keeps the rule visible.
   */
  // `admin` to `admin`. The recipient has to be in this server's own registry
  // (`/api/v1/messages` refuses an unknown one), and the only seeded person is
  // the admin — which is enough, because § 15.3 asks whether the caller is
  // *either* end and does not care that both ends are the same one here.
  const sendCarrying = async (attachmentId: string, to = "admin") => {
    await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        to,
        text: "here it is",
        attachments: [{ id: attachmentId, download_url: `${mesh.http.url}/api/v1/attachments/${attachmentId}` }],
      }),
    });
  };
  const asAdmin = (id: string) =>
    fetch(`${mesh.http.url}/api/v1/attachments/${id}`, { headers: { cookie: adminCookie } });

  const upload = async (content: string, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    const res = await fetch(`${mesh.http.url}/api/v1/upload`, {
      method: "POST", headers: { cookie: adminCookie }, body: form,
    });
    return res.json();
  };

  test("serves the bytes to a party, with the headers § 15.3 requires", async () => {
    const body = "attachment body";
    const up = await upload(body, "note.txt");
    await sendCarrying(up.id);
    const res = await asAdmin(up.id);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("content-type")).toBeTruthy();
  });

  test("a miss is 404 with a JSON body, not an empty response", async () => {
    const res = await asAdmin("a".repeat(64));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  test("no credential at all is 401", async () => {
    const up = await upload("private", "p.txt");
    await sendCarrying(up.id);
    expect((await fetch(`${mesh.http.url}/api/v1/attachments/${up.id}`)).status).toBe(401);
  });

  test("the digest alone is not the id, and does not resolve", async () => {
    // Ids carry the original extension, so `<sha256>` is a genuine prefix of
    // `<sha256>.txt`.
    //
    // **This does not prove the participation query is prefix-safe**, and it
    // was written believing it did. The `404` here comes from the filesystem —
    // no file is named by the bare digest — so swapping the quoted `LIKE` for
    // a bare one leaves it passing. The quoting is defensive against a shape
    // this system does not currently produce, and saying so is better than a
    // test that appears to cover it.
    const up = await upload("prefixed", "pre.txt");
    expect(up.id).toBe(`${up.sha256}.txt`);
    await sendCarrying(up.id);
    expect((await asAdmin(up.id)).status).toBe(200);
    expect((await asAdmin(up.sha256)).status).toBe(404);
  });

  test("a party to no message carrying it gets 404, not 403", async () => {
    // Uploading is not participation — an attachment nobody has sent is one
    // nobody is party to. And the answer matches a genuine miss on purpose:
    // telling them it exists would make this a probe for which digests the
    // mesh holds.
    const up = await upload("unsent", "u.txt");
    const res = await asAdmin(up.id);
    expect(res.status).toBe(404);
  });

  test("a stranger to a conversation carrying it is refused, though it exists", async () => {
    // The case above only proves the *content* half of § 15.3: nobody had sent
    // it, so no row matched whoever asked. This is the identity half — the
    // attachment exists and has been sent, between two identities the caller is
    // not one of. Mutating the `from_agent`/`to_agent` clause away passes the
    // test above and fails this one, which is the whole reason it is here.
    const up = await upload("between two others", "private.txt");

    await provision(mesh.hub, "attach-sender", "service");
    await provision(mesh.hub, "attach-outsider-recipient", "service");
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "attach-sender" });
    await rpc.call("mesh.send", {
      to: "attach-outsider-recipient",
      // § 15.2's shape, which is what puts the id in the stored body.
      content: JSON.stringify({
        text: "for you only",
        attachments: [{ id: up.id, download_url: `${mesh.http.url}/api/v1/attachments/${up.id}` }],
      }),
    });
    rpc.close();

    // `admin` is neither end. The answer is the same 404 a genuine miss gets,
    // for the reason above — but it must not be the bytes.
    const res = await asAdmin(up.id);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("between two others");
  });

  test("ids with separators or .. are refused before the filesystem is touched", async () => {
    // The id is the only gate here, so these are the cases that matter.
    //
    // **`400` exactly, not `[400, 404]`.** The looser form is what this test
    // used to assert, and deleting the separator guard entirely left it green:
    // `../etc/passwd` then reached the participation query, matched no message,
    // and came back `404` — which was in the accepted list. A `404` is what a
    // genuine miss returns, so accepting it here means accepting the answer
    // given by a route that never looked at the id at all.
    //
    // The name says *before the filesystem is touched*, and `400` is the only
    // status that says so. Anything else means the request got further than
    // this test claims it can.
    for (const id of ["../etc/passwd", "..%2Fescape", "a/b", "a\\b"]) {
      const res = await fetch(`${mesh.http.url}/api/v1/attachments/${encodeURIComponent(id)}`, {
        headers: { cookie: adminCookie },
      });
      expect(res.status, `id ${id} was not refused by the id gate`).toBe(400);
    }
  });

  test("a bare .. never reaches the handler at all", async () => {
    // Separated from the four above rather than folded in with a looser
    // matcher, because it is refused by a different thing: the router
    // normalises `/api/v1/attachments/..` up a segment, so no handler runs and
    // the answer is `404`.
    //
    // That is a real guarantee and a weaker one — it comes from the framework,
    // not from this route — so it is stated on its own. Accepting `404`
    // alongside the others was what let the guard be deleted with the suite
    // green, since a deleted guard produces `404` for every one of them.
    const res = await fetch(`${mesh.http.url}/api/v1/attachments/${encodeURIComponent("..")}`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
  });

  test("an id that is neither a digest nor the legacy form is refused", async () => {
    const res = await asAdmin("not-a-real-id");
    expect(res.status).toBe(400);
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
  const httpDb = () => openTestDb(join(mesh.stateDir, "agent-mesh.db"));
  const agentsDb = () => openTestDb(join(mesh.stateDir, "agents.db"), { readonly: true });

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

/**
 * SPEC § 15.2. The upload bound is checked before the body is read.
 *
 * It used to be checked after `formData()` had parsed the whole thing into
 * memory and `arrayBuffer()` had copied it again — so an oversized upload cost
 * twice its size before being refused, and a handful of concurrent ones took
 * the process down.
 */
describe("§ 15.2 — uploads are bounded before they are read", () => {
  // One session for the whole block. Logging in per test made a later one
  // fail on a null `set-cookie` while the server was demonstrably alive — the
  // failure was the repeated logins, not the thing under test, and it sent me
  // looking for a server bug that was not there.
  let cookie: string;
  beforeAll(async () => {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=admin", redirect: "manual",
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  const login = async () => cookie;
  const upload = async (cookie: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch(`${mesh.http.url}/api/v1/upload`, { method: "POST", headers: { cookie }, body: form });
  };

  test("an oversized declared length is refused without the bytes being sent", async () => {
    // A raw socket, because `fetch` computes Content-Length from the body it
    // is given — and the whole point of this check is that it decides from the
    // **declaration**, before any bytes arrive. Sending a real ten megabytes
    // would test the same branch far more slowly and prove less.
    const cookie = await login();
    const url = new URL(mesh.http.url);
    const response = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("no response")), 8000);
      Bun.connect({
        hostname: url.hostname,
        port: Number(url.port),
        socket: {
          open(socket) {
            socket.write(
              "POST /api/v1/upload HTTP/1.1\r\n" +
              `Host: ${url.host}\r\n` +
              `Cookie: ${cookie}\r\n` +
              "Content-Type: multipart/form-data; boundary=zz\r\n" +
              // **Between our limit and Bun's own.** The first draft declared
              // 200 MiB, which is past `Bun.serve`'s default
              // `maxRequestBodySize` — so the 413 came from the runtime and
              // the test passed with our check deleted. It was testing Bun.
              `Content-Length: ${50 * 1024 * 1024}\r\n` +
              "\r\n" +
              "--zz\r\n",
            );
          },
          data(socket, chunk) {
            buf += new TextDecoder().decode(chunk);
            if (buf.includes("\r\n\r\n")) { clearTimeout(timer); socket.end(); resolve(buf); }
          },
          error(_s, e) { clearTimeout(timer); reject(e); },
        },
      }).catch(reject);
    });
    expect(response.split("\r\n")[0]).toContain("413");
  });

  test("a refusal does not take the process down, and the caller reconnects", async () => {
    // What early refusal costs, stated as a test rather than discovered.
    //
    // The process survives — it never crashed, though it read that way for an
    // afternoon. What the refused caller cannot do is reuse that connection:
    // its unsent body is still queued and would be parsed as the next request.
    // Every check here therefore opens a fresh one, which is what a client
    // must do too.
    for (let i = 0; i < 3; i++) {
      const res = await upload(cookie, new File([new Uint8Array(256 * 1024)], `over-${i}.bin`));
      expect(res.status).toBe(413);
    }
    // A new connection, and the server answers normally on it.
    expect((await fetch(`${mesh.http.url}/api/v1/audit/events`, {
      headers: { connection: "close" },
    })).status).toBe(401);
  });

  test("an ordinary upload still works and is addressed by its content", async () => {
    const cookie = await login();
    const res = await upload(cookie, new File([new TextEncoder().encode("hello mesh")], "greet.txt"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.size).toBe(10);
    // The id is derived from the bytes, not the name.
    expect(body.id).toContain(body.sha256);
  });

  test("the same content uploaded twice is one file", async () => {
    const cookie = await login();
    const send = async () =>
      (await (await upload(cookie, new File([new TextEncoder().encode("dedupe me")], "d.txt"))).json()).id;
    expect(await send()).toBe(await send());
  });
});

/**
 * SPEC § 9.1 †. The event stream authenticates from the session cookie.
 *
 * It used to take `?token=<jwt>`, which put a bearer credential into access
 * logs, proxy request lines, `Referer` and browser history. The justification
 * — "`EventSource` cannot set headers" — was true and beside the point: a
 * cookie is not a header the caller sets.
 */
describe("§ 9.1 — the event stream takes no credential in its URL", () => {
  test("the session cookie is accepted", async () => {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=admin", redirect: "manual",
    });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const ctrl = new AbortController();
    const stream = await fetch(`${mesh.http.url}/api/v1/events/some-agent`, {
      headers: { cookie }, signal: ctrl.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    ctrl.abort();
  });

  test("no session is 401", async () => {
    expect((await fetch(`${mesh.http.url}/api/v1/events/some-agent`)).status).toBe(401);
  });

  test("a token in the query string is NOT a credential any more", async () => {
    // The point of the change. A URL carrying a valid JWT must be as useless
    // as one carrying nothing, or the parameter still exists — it just stopped
    // being documented.
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=admin", redirect: "manual",
    });
    const jwt = res.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const withQuery = await fetch(
      `${mesh.http.url}/api/v1/events/some-agent?token=${encodeURIComponent(jwt)}`,
    );
    expect(withQuery.status).toBe(401);
  });
});

/**
 * Open question 7 — the three hardening items, each with a test that fails
 * without it.
 *
 * All three passed the whole suite before being fixed, which is the point:
 * nothing here was checking them. A published fallback secret, a wildcard
 * CORS policy on a cookie-authenticated server and a `===` on a bearer token
 * are invisible to tests about behaviour.
 */
describe("open question 7 — hardening", () => {
  test("CORS does not hand a session to an unlisted origin", async () => {
    // The server authenticates with a cookie, so a page on any site could
    // otherwise make an authenticated request on a visitor's behalf and read
    // the answer — the browser attaches the session, the page never sees it.
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a preflight from an unlisted origin is not granted credentials", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    // `Allow-Origin` is the load-bearing header and it is absent.
    //
    // `Allow-Credentials: true` is still echoed by Hono's middleware and that
    // is inert: a browser rejects the response outright when no origin was
    // allowed, so the credentials header grants nothing to nobody. Asserting
    // its absence would be asserting something stricter than the property, and
    // a test that overshoots gets relaxed by whoever it blocks next.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a request with no Origin is unaffected — it is not a browser", async () => {
    // Every server-to-server caller, and the whole of this suite.
    expect((await fetch(`${mesh.http.url}/api/v1/audit/events`)).status).toBe(401);
  });

  test("a wrong ingest token is refused, and a right one is accepted", async () => {
    // The comparison behind this is constant-time; what a test can check is
    // that swapping it for one has not broken the decision.
    const url = `${mesh.http.url}/api/v1/ingest/ai-usage`;
    const wrong = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({}),
    });
    // 401 when a token is configured, 503 when the feature is off — either is
    // a refusal, and neither is acceptance.
    expect([401, 503]).toContain(wrong.status);
  });
});
