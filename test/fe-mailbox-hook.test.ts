/**
 * The other front end's mailbox hook, which nothing was measuring.
 *
 * `scripts/fe-mailbox-hook.ts` is how `platform-fe-antigravity` receives mail:
 * one process per turn, a high-water mark in a file, and two shapes of answer
 * depending on which event fired. Every way it fails is silent from where it
 * runs — a hook that returns nothing looks exactly like an empty inbox, and the
 * other side waits on an answer nobody read.
 *
 * Spawned rather than imported: it is a top-level script that reads stdin, so
 * running it is the only way to ask it anything.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runChild } from "./child-output.ts";

const HOOK = resolve(import.meta.dir, "..", "scripts", "fe-mailbox-hook.ts");
const AGENT = "platform-fe-antigravity";

interface Mail {
  id: number;
  from: string;
  to: string;
  body: string;
  createdAt: number;
  isRead?: boolean;
}

/** A mailer that serves a fixed inbox and records what was asked of it. */
function mailer(messages: Mail[]) {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      asked.push(new URL(req.url).search);
      return Response.json({ messages });
    },
  });
  return { asked, server, url: `http://127.0.0.1:${server.port}/api/mail` };
}

async function fire(url: string, stateDir: string, input: unknown) {
  // Read from files, not pipes: `new Response(child.stdout).text()` threw
  // `EBADF: bad file descriptor` out of a reader in CI and failed a test whose
  // child had run correctly. See `test/child-output.ts`.
  const ran = await runChild(["bun", HOOK], {
    env: { ...process.env, AGENT_MESH_MAILBOX_URL: url, AGENT_MESH_KEY_DIR: stateDir },
    stdin: JSON.stringify(input),
  });
  return {
    code: ran.code,
    said: ran.stdout,
    complained: ran.stderr,
    answer: ran.stdout.trim() ? JSON.parse(ran.stdout) : null,
  };
}

const letter = (id: number, body: string, isRead = false): Mail => ({
  id,
  from: "platform-claude",
  to: AGENT,
  body,
  createdAt: 1_700_000_000_000,
  isRead,
});

const stateDir = () => mkdtempSync(join(tmpdir(), "fe-mailbox-"));
const markOf = (dir: string) => readFileSync(join(dir, `${AGENT}.mailbox-mark`), "utf8").trim();

describe("delivering to the front end", () => {
  test("a turn starting is given the mail as context", async () => {
    const { server, url } = mailer([letter(7, "the contract moved to v4")]);
    const dir = stateDir();
    try {
      const { code, answer } = await fire(url, dir, { hookName: "PreInvocation" });
      expect(code).toBe(0);
      expect(answer.injectSteps[0].ephemeralMessage).toContain("the contract moved to v4");
      // Named, so a reader can tell who is owed an answer.
      expect(answer.injectSteps[0].ephemeralMessage).toContain("platform-claude");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("a turn ending is continued rather than allowed to stop", async () => {
    // The Stop shape: mail that landed during a turn continues it, or the
    // answer waits for whenever somebody next types.
    const { server, url } = mailer([letter(9, "a route now refuses without a tenant")]);
    const dir = stateDir();
    try {
      const { answer } = await fire(url, dir, { terminationReason: "endTurn" });
      expect(answer.decision).toBe("continue");
      expect(answer.reason).toContain("a route now refuses without a tenant");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("an empty inbox still answers, in the shape the event expects", async () => {
    // Saying nothing at all is not an option: the runner reads this output.
    const { server, url } = mailer([]);
    const dir = stateDir();
    try {
      const starting = await fire(url, dir, { hookName: "PreInvocation" });
      const ending = await fire(url, dir, { executionNum: 2 });
      expect({ starting: starting.answer, ending: ending.answer }).toEqual({
        starting: { injectSteps: [] },
        ending: { decision: "allow" },
      });
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("the high-water mark", () => {
  test("a message is delivered once and not again", async () => {
    const { server, url } = mailer([letter(11, "the tag is pinned at v0.4.2")]);
    const dir = stateDir();
    try {
      const first = await fire(url, dir, { hookName: "PreInvocation" });
      expect(first.answer.injectSteps).toHaveLength(1);
      expect(markOf(dir)).toBe("11");

      // The mailbox keeps everything — nothing is deleted — so the mark is the
      // only thing standing between one delivery and every turn replaying the
      // same message.
      const second = await fire(url, dir, { hookName: "PreInvocation" });
      expect(second.answer).toEqual({ injectSteps: [] });
    } finally {
      server.stop();
    }
  }, 20_000);

  test("the first run ever falls back to what the mailer calls unread", async () => {
    // No mark yet, and the alternative is replaying the whole inbox. This is
    // the one moment `isRead` is consulted.
    const { server, url } = mailer([letter(3, "old news", true), letter(4, "new news", false)]);
    const dir = stateDir();
    try {
      const { answer } = await fire(url, dir, { hookName: "PreInvocation" });
      const said = answer.injectSteps[0].ephemeralMessage as string;
      expect({ carried: said.includes("new news"), replayed: said.includes("old news") }).toEqual({
        carried: true,
        replayed: false,
      });
      // Still marked past both, so the read one cannot come back either.
      expect(markOf(dir)).toBe("4");
    } finally {
      server.stop();
    }
  }, 20_000);

  test("a mark left behind by nothing readable is treated as no mark", async () => {
    const dir = stateDir();
    writeFileSync(join(dir, `${AGENT}.mailbox-mark`), "not a number\n");
    const { server, url } = mailer([letter(5, "still delivered", false)]);
    try {
      const { answer } = await fire(url, dir, { hookName: "PreInvocation" });
      expect(answer.injectSteps[0].ephemeralMessage).toContain("still delivered");
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("when there is no mailer", () => {
  test("the turn is not blocked by a mailbox nobody is running", async () => {
    // The normal state on a machine doing no cross-agent work. A hook that
    // threw here would stop the other front end from working at all.
    const dir = stateDir();
    const { code, answer } = await fire("http://127.0.0.1:9/api/mail", dir, { hookName: "PreInvocation" });
    expect({ code, answer }).toEqual({ code: 0, answer: { injectSteps: [] } });
  }, 20_000);
});
