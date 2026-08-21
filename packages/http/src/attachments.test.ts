/**
 * Who may pull an attachment, and how the route says no (SPEC § 15.3).
 *
 * The route was open, on the reasoning that a content-addressed id is
 * unguessable and therefore a capability. That holds until the id appears in a
 * log line, an audit event, or a forwarded `download_url` — a capability that
 * travels inside the thing it protects is one nobody can withdraw. The gate
 * that replaced the reasoning had no test.
 *
 * **The refusals matter more than the download here.** Two of them are the same
 * sentence on purpose: an attachment the caller is not party to and one that
 * does not exist both answer `404`, because distinguishing them turns this
 * route into a probe for which digests the mesh holds. A test that only checked
 * the happy path would let either drift into naming what it found.
 *
 * Sessions are minted here rather than borrowed from `/auth/local`. The seeded
 * admin's password is changed by another file in this directory, and bun runs a
 * directory in one process — a test that signs in with the default is a test
 * that depends on running first.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "attachments-probe";

const { mayDownload, participants } = await import("./attachment-access");
const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { hubSchema, openStore } = await import("@agent-mesh/store");
const { createHash, randomUUID } = await import("node:crypto");

/**
 * The hub's store, which is where participation is read from.
 *
 * `main.ts` opens this one `readonly` — http never writes another process's
 * messages — so a test that needs a message to exist has to open it for
 * writing itself. Same file, so what is written here is what the route reads.
 */
const hub = openStore("hub", { create: true });
hubSchema.migrate(hub);
const hubDb = () => hub;

let n = 0;
const uniq = (p: string) => `att-${p}-${++n}-${process.pid}`;
/** A digest-shaped id nothing has ever stored. */
const digestId = () => `${createHash("sha256").update(randomUUID()).digest("hex")}.txt`;

/** A message carrying an attachment id, the way § 15.2 puts it in the body. */
const carry = (from: string, to: string, id: string, sentBy: string | null = null) =>
  hubDb().prepare(
    `INSERT INTO messages (id, from_agent, to_agent, sent_by, content, status, ts)
     VALUES (?, ?, ?, ?, ?, 'delivered', datetime('now'))`,
  ).run(uniq("msg"), from, to, sentBy, JSON.stringify({ text: "see attached", attachments: [{ id }] }));

/**
 * An approved person, and the cookie their browser would carry.
 *
 * The request row comes first: `approveUser` moves a `pending` row to
 * `approved` and reports how many it changed, so approving somebody who never
 * asked changes nothing and reports it honestly. Asserted rather than assumed,
 * because a helper that silently produces an unapproved session would make
 * every `403` below look like the behaviour under test.
 */
async function approved(login = uniq("person")) {
  const user = upsertUser(900000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  // `member` for the same reason the refusal case states it: an admin is
  // approved by definition, so a helper that let the role vary would sometimes
  // prove approval through the `pending_approvals` row it just wrote and
  // sometimes through being first in the table.
  const jwt = await signJwt({ github_id: user.github_id, github_login: user.github_login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

const get = (id: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://att-probe/api/v1/attachments/${id}`, { headers }));

describe("who counts as party to an attachment", () => {
  test("the sender does, and so does the recipient", () => {
    const id = digestId();
    carry("alice-att", "bob-att", id);
    expect(mayDownload(hubDb(), "alice-att", id)).toBe(true);
    expect(mayDownload(hubDb(), "bob-att", id)).toBe(true);
  });

  test("a third party does not", () => {
    const id = digestId();
    carry("alice-att", "bob-att", id);
    expect(mayDownload(hubDb(), "mallory-att", id)).toBe(false);
  });

  /**
   * A proxy carried the message; carrying it is not being party to it. § 8.2
   * already distinguishes the two names, and this is the place the distinction
   * decides who may read bytes.
   */
  test("and neither does the proxy that carried it", () => {
    const id = digestId();
    carry("alice-att", "bob-att", id, "proxy-att");
    expect(mayDownload(hubDb(), "proxy-att", id)).toBe(false);
  });

  test("an attachment nobody has sent has no parties at all", () => {
    expect(mayDownload(hubDb(), "alice-att", digestId())).toBe(false);
    expect(participants(hubDb(), digestId())).toEqual([]);
  });

  /**
   * The same bytes may appear in ten conversations — content addressing is the
   * point — so this is a search over participation, not a lookup of an owner.
   */
  test("participants gathers both sides of every message carrying it, once", () => {
    const id = digestId();
    carry("alice-att", "bob-att", id);
    carry("carol-att", "alice-att", id);
    expect(participants(hubDb(), id)).toEqual(["alice-att", "bob-att", "carol-att"]);
  });
});

describe("what the route refuses before it looks at the disk", () => {
  test("an id carrying a separator or a traversal", async () => {
    for (const id of ["..%2Fetc%2Fpasswd", "a..b", "x%2Fy", "x%5Cy"]) {
      const res = await get(id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Invalid attachment id");
    }
  });

  /**
   * **A bare `..` never reaches the handler**, so the `400` above is not what
   * stops the traversal everybody pictures: the router normalises the path
   * first and the request lands on no route at all. Measured, because the
   * check reads as though it were the defence and it is the second one —
   * `%2E%2E` takes the same path, so percent-encoding does not get past the
   * normalisation either.
   *
   * Recorded rather than removed. The clause still earns its place for the
   * embedded forms above, and a reader who assumes it is the only guard would
   * be wrong in the direction that matters least — there are two.
   */
  test("and a bare traversal is refused by the router before the route sees it", async () => {
    for (const id of ["..", "%2E%2E"]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Not found");
    }
  });

  test("an id that is neither a digest nor a legacy name", async () => {
    const res = await get("not-a-digest");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid attachment id format");
  });

  test("a caller with no session and no signature", async () => {
    const res = await get(digestId());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("§ 9.2.1");
  });

  /**
   * Authenticated but not approved is `403`, not `401`. They proved who they
   * are; what they lack is permission, and telling them to sign in sends them
   * to fix the wrong thing.
   */
  test("a signed-in person the operator has not approved yet", async () => {
    const login = uniq("waiting");
    const user = upsertUser(910000 + n, login);
    // **`role` is stated, not read back.** `upsertUser` makes the very first
    // user of an empty `users` table an admin, and an admin is approved by
    // definition — so whether this session is approved would depend on how many
    // people the shared table happened to hold when the file ran. The session
    // is what the guard reads, and a waiting person's session says `member`.
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
    const res = await get(digestId(), { cookie: `mesh_token=${jwt}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Account pending approval");
  });
});

describe("the answer that is deliberately the same twice", () => {
  /**
   * Not party to it, and does not exist at all, are one sentence. Telling them
   * apart would make this route a probe for which digests the mesh holds — and
   * the ids are digests, so an answer of *that one exists* is information about
   * content the caller cannot otherwise confirm.
   */
  test("an attachment the caller is not party to reads as not found", async () => {
    const me = await approved();
    const id = digestId();
    carry("someone-else", "another", id);
    const res = await get(id, { cookie: me.cookie });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });

  test("and so does one nobody ever sent", async () => {
    const me = await approved();
    const res = await get(digestId(), { cookie: me.cookie });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });

  /**
   * Party to it and the bytes are absent: still `404`, and reached by a
   * different branch. Worth its own case because the two arrive at one sentence
   * from opposite sides, and a change that dropped either would look green.
   */
  test("and so does one the caller may read whose bytes are gone", async () => {
    const me = await approved();
    const id = digestId();
    carry(me.login, "peer-att", id);
    expect(mayDownload(hubDb(), me.login, id)).toBe(true);
    const res = await get(id, { cookie: me.cookie });
    expect(res.status).toBe(404);
  });
});

/**
 * The bytes themselves, which the refusals above never reach.
 *
 * Getting here needs a real blob, and the only thing that makes one is
 * `POST /api/v1/upload` — so this drives both ends of § 15: the route that
 * stores content-addressed bytes, and the one that serves them to a party of
 * the message carrying them.
 */
describe("serving an attachment to somebody entitled to it", () => {
  /** Upload as this person, and return the § 15.2 metadata. */
  async function store(cookie: string, name: string, content: string) {
    const boundary = `----att-probe-${++n}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const bytes = enc.encode(content);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    const res = await app.fetch(new Request("http://att-probe/api/v1/upload", {
      method: "POST",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
      body: body as unknown as BodyInit,
    }));
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; sha256: string; size: number };
  }

  test("answers the bytes, their type, and a name a browser can save", async () => {
    const me = await approved();
    const content = `the quick brown fox ${uniq("body")}`;
    const meta = await store(me.cookie, "report.txt", content);
    carry(me.login, "peer-att", meta.id);

    const res = await get(meta.id, { cookie: me.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-length")).toBe(String(meta.size));
    // `inline`, because these are shown in a conversation rather than saved by
    // default — and the filename is what a browser writes if somebody does.
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(await res.text()).toBe(content);
  });

  /**
   * **The original name is lost on purpose.** A `sha256` id is the file; the
   * name a person typed is not part of it, so the display name falls back to
   * the id rather than to something the server never kept.
   */
  test("names a digest-keyed attachment after its digest", async () => {
    const me = await approved();
    const meta = await store(me.cookie, "quarterly summary.txt", `named ${uniq("body")}`);
    carry(me.login, "peer-att", meta.id);
    const res = await get(meta.id, { cookie: me.cookie });
    expect(res.headers.get("content-disposition")).toContain(meta.id);
    expect(res.headers.get("content-disposition")).not.toContain("quarterly");
  });

  /**
   * A legacy `<ts>-<name>` id kept the name on disk, so that one is served
   * under it. Both id shapes are accepted (§ 15.2 and the pre-hash contract),
   * and the difference is only which name a browser is given.
   */
  test("and a legacy id after the name inside it", async () => {
    const me = await approved();
    // The name is captured rather than rebuilt: `n` moves whenever any helper
    // in this file runs, and an id read twice is two ids.
    const legacyName = `notes-${++n}.txt`;
    const legacyId = `1734567890123-${legacyName}`;
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { stateDir: dir } = await import("@agent-mesh/store");
    writeFileSync(joinPath(dir(), "uploads", legacyId), "legacy bytes");
    carry(me.login, "peer-att", legacyId);

    const res = await get(legacyId, { cookie: me.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(legacyName);
    expect(res.headers.get("content-disposition")).not.toContain("1734567890123");
  });

  /** The recipient is a party too, not only the sender. */
  test("serves it to the recipient as readily as to the sender", async () => {
    const sender = await approved();
    const recipient = await approved();
    const meta = await store(sender.cookie, "shared.txt", `shared ${uniq("body")}`);
    carry(sender.login, recipient.login, meta.id);
    expect((await get(meta.id, { cookie: recipient.cookie })).status).toBe(200);
  });
});
