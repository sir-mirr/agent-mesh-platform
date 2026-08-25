/**
 * The other front end's mailbox client: `check`, `peek`, and `send`.
 *
 * The hook beside it (`fe-mailbox-hook.ts`) is what a turn calls; this is what
 * a person calls. Both keep the same high-water mark file, so an error in
 * either is an error in the other's bookkeeping — a mark moved by a `peek` is
 * mail the next turn never sees, and a mark not moved by a `check` is mail
 * delivered twice.
 *
 * Spawned, not imported: it decides everything from `process.argv` at the top
 * level and exits.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLIENT = resolve(import.meta.dir, "..", "scripts", "fe-mailbox.ts");
const AGENT = "platform-fe-antigravity";

interface Mail {
  id: number;
  from: string;
  to: string;
  body: string;
  createdAt: number;
  isRead?: boolean;
}

interface Posted {
  from?: string;
  to?: string;
  body?: string;
}

/** A mailer that serves a fixed inbox and keeps what was posted to it. */
function mailer(messages: Mail[], status = 200) {
  const posted: Posted[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") {
        const sent = (await req.json()) as Posted;
        posted.push(sent);
        return Response.json({ id: 4242, ...sent });
      }
      if (status !== 200) return new Response("no", { status });
      return Response.json({ messages });
    },
  });
  return { posted, server, url: `http://127.0.0.1:${server.port}/api/mail` };
}

async function run(url: string, stateDir: string, args: string[], stdin = "") {
  const proc = Bun.spawn(["bun", CLIENT, ...args], {
    env: { ...process.env, AGENT_MESH_MAILBOX_URL: url, AGENT_MESH_KEY_DIR: stateDir },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [said, complained] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, said, complained };
}

const letter = (id: number, body: string, isRead = false): Mail => ({
  id,
  from: "platform-claude",
  to: AGENT,
  body,
  createdAt: 1_700_000_000_000,
  isRead,
});

const stateDir = () => mkdtempSync(join(tmpdir(), "fe-mailbox-cli-"));
const markFile = (dir: string) => join(dir, `${AGENT}.mailbox-mark`);
const markOf = (dir: string) => (existsSync(markFile(dir)) ? readFileSync(markFile(dir), "utf8").trim() : null);

describe("checking the mail", () => {
  test("prints what is new, and only once", async () => {
    const { server, url } = mailer([letter(31, "the ratchet moved"), letter(32, "and again")]);
    const dir = stateDir();
    try {
      const first = await run(url, dir, ["check"]);
      expect(first.said).toContain("the ratchet moved");
      expect(first.said).toContain("and again");
      expect(markOf(dir)).toBe("32");

      const second = await run(url, dir, ["check"]);
      expect({ replayed: second.said.includes("the ratchet moved"), code: second.code }).toEqual({
        replayed: false,
        code: 0,
      });
      expect(second.said).toContain("No new messages");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("the first run ever takes the mailer's word for what is unread", async () => {
    const { server, url } = mailer([letter(3, "old news", true), letter(4, "new news", false)]);
    const dir = stateDir();
    try {
      const { said } = await run(url, dir, ["check"]);
      expect({ carried: said.includes("new news"), replayed: said.includes("old news") }).toEqual({
        carried: true,
        replayed: false,
      });
      // Marked past both: the read one cannot come back on the next run either.
      expect(markOf(dir)).toBe("4");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("check is the default, so a bare invocation drains rather than doing nothing", async () => {
    const { server, url } = mailer([letter(8, "delivered by default")]);
    const dir = stateDir();
    try {
      const { said, code } = await run(url, dir, []);
      expect({ said: said.includes("delivered by default"), code }).toEqual({ said: true, code: 0 });
    } finally {
      server.stop();
    }
  }, 20_000);

  test("an empty mailbox says so rather than printing an empty report", async () => {
    const { server, url } = mailer([]);
    const dir = stateDir();
    try {
      const { said, code } = await run(url, dir, ["check"]);
      expect({ code, marked: markOf(dir) }).toEqual({ code: 0, marked: null });
      expect(said).toContain("No messages");
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("peeking", () => {
  test("leaves the mark where it found it, so the next check still delivers", async () => {
    // The local mark is the half this command controls. The mailer's own
    // `isRead` is not: a GET spends it, which is why the hook consults that
    // flag only on the very first run.
    const { server, url } = mailer([letter(51, "still owed an answer")]);
    const dir = stateDir();
    writeFileSync(markFile(dir), "50");
    try {
      const peeked = await run(url, dir, ["peek"]);
      expect(peeked.said).toContain("still owed an answer");
      expect(peeked.said).toContain("NEW");
      expect(markOf(dir)).toBe("50");

      const checked = await run(url, dir, ["check"]);
      expect(checked.said).toContain("still owed an answer");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("says which messages have been seen before", async () => {
    const { server, url } = mailer([letter(10, "answered already"), letter(11, "not yet")]);
    const dir = stateDir();
    writeFileSync(markFile(dir), "10");
    try {
      const { said } = await run(url, dir, ["peek"]);
      const seen = said.slice(said.indexOf("#10"), said.indexOf("#11"));
      const fresh = said.slice(said.indexOf("#11"));
      expect({ seen: seen.includes("[SEEN]"), fresh: fresh.includes("[NEW]") }).toEqual({
        seen: true,
        fresh: true,
      });
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("sending", () => {
  test("posts the body under this agent's own name", async () => {
    const { posted, server, url } = mailer([]);
    const dir = stateDir();
    try {
      const { said, code } = await run(url, dir, ["send", "platform-claude", "the", "floor", "held"]);
      expect(posted).toEqual([{ from: AGENT, to: "platform-claude", body: "the floor held" }]);
      expect({ code, named: said.includes("4242") }).toEqual({ code: 0, named: true });
    } finally {
      server.stop();
    }
  }, 20_000);

  test("a body given as a file is sent whole, newlines and all", async () => {
    const { posted, server, url } = mailer([]);
    const dir = stateDir();
    const path = join(dir, "body.txt");
    writeFileSync(path, "one\n\ntwo — 마지막 줄\n");
    try {
      await run(url, dir, ["send", "platform-claude", "--file", path]);
      expect(posted[0]?.body).toBe("one\n\ntwo — 마지막 줄\n");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("an empty body is refused rather than posted", async () => {
    const { posted, server, url } = mailer([]);
    const dir = stateDir();
    try {
      const { code, complained } = await run(url, dir, ["send", "platform-claude"], "   \n");
      expect({ code, posted }).toEqual({ code: 1, posted: [] });
      expect(complained).toContain("empty");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("a mailer that refuses the post fails the command rather than reporting a send", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
    const dir = stateDir();
    try {
      const { code, said, complained } = await run(
        `http://127.0.0.1:${server.port}/api/mail`,
        dir,
        ["send", "platform-claude", "into the void"],
      );
      expect({ code, claimed: said.includes("Sent") }).toEqual({ code: 1, claimed: false });
      expect(complained).toContain("503");
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("when the mailer is not there", () => {
  test("checking says where it tried rather than pretending the inbox is empty", async () => {
    const dir = stateDir();
    const { code, complained, said } = await run("http://127.0.0.1:9/api/mail", dir, ["check"]);
    expect(code).toBe(0);
    expect(complained).toContain("Failed to reach mailbox");
    expect(said).toContain("No messages");
    expect(markOf(dir)).toBe(null);
  }, 20_000);

  test("a mailer answering with an error is not read as an empty inbox", async () => {
    const { server, url } = mailer([], 500);
    const dir = stateDir();
    try {
      const { complained } = await run(url, dir, ["check"]);
      expect(complained).toContain("status 500");
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("an unknown command", () => {
  test("is told what the commands are, not silently treated as a check", async () => {
    const { server, url } = mailer([letter(1, "must not be drained by a typo")]);
    const dir = stateDir();
    try {
      const { said, code } = await run(url, dir, ["chekc"]);
      expect({ code, drained: said.includes("must not be drained by a typo"), marked: markOf(dir) })
        .toEqual({ code: 0, drained: false, marked: null });
      expect(said).toContain("Usage:");
    } finally {
      server.stop();
    }
  }, 20_000);
});
