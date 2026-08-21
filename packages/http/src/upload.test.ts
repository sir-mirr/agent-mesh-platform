/**
 * `POST /api/v1/upload` — the one route that takes bytes from a person.
 *
 * Fifty-three uncovered lines, and the shape of them is a refusal ladder that
 * exists because of a specific failure: `c.req.formData()` parses the whole
 * multipart body into memory before anything can look at it, and
 * `file.arrayBuffer()` copied it again — so a 100 MiB upload cost 200 MiB and
 * the size check ran after both. A handful of concurrent uploads took the
 * process down.
 *
 * **So `Content-Length` is checked first, and it is a claim.** It is the only
 * bound available *before* accepting bytes, which is why it is required at all;
 * the real count is enforced below as well, because a declaration is the part
 * an honest client always sends and a dishonest one never has to.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET ||= "upload-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { stateDir } = await import("@agent-mesh/store");
const { createHash } = await import("node:crypto");

const UPLOAD_MAX_BYTES = parseInt(process.env.AGENT_MESH_UPLOAD_MAX_BYTES ?? "", 10) || 10 * 1024 * 1024;
const UPLOAD_ENVELOPE_SLACK = 64 * 1024;

let n = 0;
const uniq = (p: string) => `up-${p}-${++n}-${process.pid}`;

async function session(approved: boolean) {
  const login = uniq(approved ? "member" : "waiting");
  const user = upsertUser(450000 + n, login);
  createPendingApproval(login, user.github_id);
  if (approved) expect(approveUser(login)).toBe(true);
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return `mesh_token=${jwt}`;
}

/**
 * A multipart body built by hand, because the declared length is the subject.
 *
 * `new Request(url, { body: formData })` does not set `content-length` in this
 * runtime — every such request is refused `411` before the route reaches
 * anything else, which is what the first version of this file measured and
 * mistook for a session problem. Assembling the envelope here means its real
 * length is known, so *declared* and *actual* can be made to differ on purpose.
 */
function multipart(file: { name: string; bytes: Uint8Array } | null): { body: Uint8Array; type: string } {
  const boundary = `----upload-probe-${++n}`;
  const enc = new TextEncoder();
  if (!file) {
    return { body: enc.encode(`--${boundary}--\r\n`), type: `multipart/form-data; boundary=${boundary}` };
  }
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + file.bytes.length + tail.length);
  body.set(head, 0);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/** `declared`: omitted sends the true length, `null` sends none. */
function upload(
  cookie: string | null,
  file: { name: string; bytes: Uint8Array } | null,
  declared?: string | null,
) {
  const { body, type } = multipart(file);
  const headers = new Headers({ "content-type": type });
  if (cookie) headers.set("cookie", cookie);
  const length = declared === undefined ? String(body.length) : declared;
  if (length !== null) headers.set("content-length", length);
  // `as BodyInit`: a `Uint8Array` is one at runtime, and the DOM lib types
  // here describe a narrower set than bun accepts.
  return app.fetch(new Request("http://upload-probe/api/v1/upload", { method: "POST", headers, body: body as unknown as BodyInit }));
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("what it refuses before it reads a byte", () => {
  test("a caller with no session", async () => {
    expect((await upload(null, { name: "a.txt", bytes: bytes("hi") })).status).toBe(401);
  });

  test("a signed-in person the operator has not approved", async () => {
    const waiting = await session(false);
    const res = await upload(waiting, { name: "a.txt", bytes: bytes("hi") });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Account pending approval");
  });

  /**
   * `411`, and it is the point of the ladder: without a declared length the
   * bound could only be enforced by counting bytes as they arrive, which means
   * accepting an unbounded stream before deciding to reject it.
   */
  test("a request that declares no length", async () => {
    const me = await session(true);
    const res = await upload(me, { name: "a.txt", bytes: bytes("hi") }, null);
    expect(res.status).toBe(411);
    expect((await res.json()).error).toContain("Content-Length is required");
  });

  test("a declared length that is not a non-negative integer", async () => {
    const me = await session(true);
    for (const declared of ["-1", "1.5", "lots"]) {
      const res = await upload(me, { name: "a.txt", bytes: bytes("hi") }, declared);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("non-negative integer");
    }
  });

  /**
   * The envelope, not the file: multipart adds a boundary and headers, so
   * bounding the declared body bounds the file inside it. Refused on the claim
   * alone — nothing is read.
   */
  test("a declared length over the ceiling plus its envelope slack", async () => {
    const me = await session(true);
    const over = String(UPLOAD_MAX_BYTES + UPLOAD_ENVELOPE_SLACK + 1);
    const res = await upload(me, { name: "a.txt", bytes: bytes("hi") }, over);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain(String(UPLOAD_MAX_BYTES));
  });

  test("a form carrying no file", async () => {
    const me = await session(true);
    const res = await upload(me, null);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No file provided");
  });
});

describe("what it does with bytes it accepts", () => {
  test("answers the § 15.2 metadata, keyed on the digest it computed", async () => {
    const me = await session(true);
    const content = `stored ${uniq("body")}`;
    const res = await upload(me, { name: "notes.txt", bytes: bytes(content) });
    expect(res.status).toBe(200);
    const body = await res.json();

    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    expect(body.sha256).toBe(sha256);
    // **Content-addressed, with the extension kept**: the digest alone does not
    // say how to serve it, and the GET side infers a MIME type from the suffix.
    expect(body.id).toBe(`${sha256}.txt`);
    expect(body.size).toBe(content.length);
    expect(body.name).toBe("notes.txt");
    expect(body.download_url).toContain(`/api/v1/attachments/${sha256}.txt`);
    expect(existsSync(join(stateDir(), "uploads", body.id))).toBe(true);
  });

  /**
   * The same bytes are one file, whatever the sender called them — content
   * addressing is the point. **The extension is part of the key**, though, so
   * the same bytes under `.txt` and `.md` are two, because the GET side infers
   * how to serve them from the suffix and one blob cannot be both.
   */
  test("stores the same bytes once per suffix, not once per name", async () => {
    const me = await session(true);
    const content = `twice ${uniq("body")}`;
    const first = await (await upload(me, { name: "a.txt", bytes: bytes(content) })).json();
    const sameSuffix = await (await upload(me, { name: "quite-different.txt", bytes: bytes(content) })).json();
    const otherSuffix = await (await upload(me, { name: "a.md", bytes: bytes(content) })).json();

    expect(sameSuffix.sha256).toBe(first.sha256);
    expect(sameSuffix.id).toBe(first.id);
    expect(otherSuffix.sha256).toBe(first.sha256);
    expect(otherSuffix.id).not.toBe(first.id);
    expect(existsSync(join(stateDir(), "uploads", first.id))).toBe(true);
    expect(existsSync(join(stateDir(), "uploads", otherSuffix.id))).toBe(true);
  });

  /**
   * A name is a person's, and the key does not trust it — **twice, and neither
   * layer can be shown necessary on its own.**
   *
   * The name is sanitised to `[A-Za-z0-9._-]`, and the suffix is then taken by
   * `/(\.[a-zA-Z0-9]{1,16})$/`, which would refuse anything hostile even from
   * a raw name. A registered mutation removing the sanitising survived this
   * test, correctly: `safeName` feeds nothing but that match, so the regex is
   * what actually stands between a filename and the storage key. The mutation
   * was withdrawn rather than weakened into passing.
   *
   * Recorded because the next reader deleting the sanitising as dead would be
   * right about today and wrong the moment `safeName` is used for anything
   * else — and because a layer nothing can prove necessary is exactly the kind
   * this repository keeps finding on the wrong side of a comment.
   */
  test("sanitises the name before it becomes part of a key", async () => {
    const me = await session(true);
    const content = uniq("named");
    const res = await upload(me, { name: "../../etc/pa ss wd.TXT", bytes: bytes(content) });
    const body = await res.json();
    expect(body.name).toBe("../../etc/pa ss wd.TXT");
    // The key is the digest and a lowercased suffix, with no path left in it.
    expect(body.id).toMatch(/^[0-9a-f]{64}\.txt$/);
    expect(body.id).not.toContain("/");
  });

  /** No extension is no suffix — the digest stands alone rather than gaining one. */
  test("and leaves a name with no suffix as a bare digest", async () => {
    const me = await session(true);
    const content = uniq("bare");
    const body = await (await upload(me, { name: "README", bytes: bytes(content) })).json();
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The deprecated fields are still sent, and that is deliberate: single-host
   * legacy clients read `file_path` and `filename`. Pinned so removing them is
   * a decision somebody makes rather than a tidy-up.
   */
  test("still carries the two fields legacy clients read", async () => {
    const me = await session(true);
    const body = await (await upload(me, { name: "legacy.txt", bytes: bytes(uniq("legacy")) })).json();
    expect(body.file_path).toContain(body.id);
    expect(body.filename).toBe("legacy.txt");
  });
});
