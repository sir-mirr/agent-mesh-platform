/**
 * `GET /api/v1/files`: what it will hand over, and every reason it will not.
 *
 * The route reads from the server's own disk on behalf of a signed-in person,
 * so its refusals are the whole of its security: the path policy decides
 * *where*, and these decide *what* — a directory is not a file, and a file
 * larger than the chat can render is refused with its size rather than
 * streamed.
 *
 * This file owns the `fr-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET ||= "file-route-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");

const STATE_DIR = process.env.AGENT_MESH_STATE_DIR!;
const scratch = join(STATE_DIR, "fr-files");
mkdirSync(scratch, { recursive: true });

let n = 0;
const uniq = (p: string) => `fr-${p}-${++n}-${process.pid}`;

async function reader() {
  const login = uniq("reader");
  const user = upsertUser(1_050_000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return `Bearer ${jwt}`;
}

const fetchFile = (path: string | null, cookie: string) =>
  app.fetch(new Request(
    `http://fr-probe/api/v1/files${path === null ? "" : `?path=${encodeURIComponent(path)}`}`,
    { headers: cookie ? { authorization: cookie } : {} },
  ));

/** A file of `bytes` bytes, sparse so a size limit can be tested without writing one. */
function sized(name: string, bytes: number): string {
  const path = join(scratch, name);
  writeFileSync(path, "");
  truncateSync(path, bytes);
  return path;
}

describe("who may read", () => {
  test("refuses a caller with no session", async () => {
    const res = await fetchFile(join(scratch, "anything.txt"), "");
    expect(res.status).toBe(401);
  });
});

describe("which path", () => {
  test("refuses a request that names none", async () => {
    const res = await fetchFile(null, await reader());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('"path"');
  });

  /** The policy's answer, in the shape the route gives it. */
  test("refuses a path outside the directories it serves", async () => {
    const res = await fetchFile("/etc/passwd", await reader());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("not in allowed directories");
  });

  /**
   * **A traversal that lands somewhere allowed is still refused.** The route
   * used to resolve the path before asking, which made this branch unreachable
   * — `resolve(resolve(p))` is `resolve(p)` — so the rule was written down and
   * could not fire.
   */
  test("refuses a path written with a traversal, even one that lands inside", async () => {
    const cookie = await reader();
    const real = sized("landed.txt", 8);
    // Built by hand: `join` normalises `sub/..` away, which would test the
    // string the route never receives.
    const viaDots = `${scratch}/sub/../landed.txt`;
    expect((await fetchFile(real, cookie)).status).toBe(200);
    expect((await fetchFile(viaDots, cookie)).status).toBe(403);
  });

  test("answers 404 for a path it would serve that is not there", async () => {
    const res = await fetchFile(join(scratch, uniq("missing")), await reader());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("File not found");
  });

  test("refuses a directory, which exists and is not a file", async () => {
    const dir = join(scratch, uniq("adir"));
    mkdirSync(dir, { recursive: true });
    const res = await fetchFile(dir, await reader());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Path is not a file");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("how large", () => {
  /**
   * **Refused with its size, not truncated.** The chat renders what this route
   * returns, so a limit that silently served the first 10MB of a larger file
   * would show a person a document that ends mid-sentence and say nothing.
   */
  test("refuses a file past the limit, and says how big it is", async () => {
    const big = sized(uniq("big") + ".txt", 11 * 1024 * 1024);
    const res = await fetchFile(big, await reader());
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("11.0MB > 10MB");
    rmSync(big, { force: true });
  });

  test("serves one just inside the limit", async () => {
    const ok = sized(uniq("ok") + ".txt", 10 * 1024 * 1024);
    const res = await fetchFile(ok, await reader());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    rmSync(ok, { force: true });
  });
});
