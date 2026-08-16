#!/usr/bin/env bun
/**
 * Antigravity Lifecycle Hook for platform-fe-antigravity mailbox integration.
 * Handles PreInvocation (context injection) and Stop (turn continuation).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAILBOX = process.env.AGENT_MESH_MAILBOX_URL ?? "http://localhost:3300/api/mail";
const AGENT_ID = "platform-fe-antigravity";
const TIMEOUT_MS = 2000;

const STATE_DIR = process.env.AGENT_MESH_KEY_DIR ?? join(homedir(), ".claude", "agent-mesh");
const MARK_FILE = join(STATE_DIR, `${AGENT_ID}.mailbox-mark`);

interface Mail {
  id: number;
  from: string;
  to: string;
  body: string;
  createdAt: number;
  isRead?: boolean;
}

function readMark(): number | null {
  try {
    const value = Number(readFileSync(MARK_FILE, "utf8").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeMark(id: number): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(MARK_FILE, String(id), { mode: 0o600 });
  } catch {
    // ignore
  }
}

async function drain(): Promise<Mail[]> {
  const url = `${MAILBOX}?agentId=${encodeURIComponent(AGENT_ID)}`;
  let messages: Mail[];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    messages = ((await res.json()) as { messages?: Mail[] }).messages ?? [];
  } catch {
    return [];
  }
  if (messages.length === 0) return [];

  const mark = readMark();
  const fresh =
    mark === null
      ? messages.filter((m) => m.isRead !== true)
      : messages.filter((m) => m.id > mark);

  const highest = messages.reduce((max, m) => (m.id > max ? m.id : max), mark ?? 0);
  writeMark(highest);

  return fresh.sort((a, b) => a.id - b.id);
}

function render(messages: Mail[]): string {
  const parts = messages.map((m) => {
    const when = new Date(m.createdAt).toISOString();
    return `--- mail #${m.id} from ${m.from} at ${when} ---\n${m.body}`;
  });
  return [
    `[platform-fe-antigravity mailbox] ${messages.length} new message(s) received.`,
    ``,
    ...parts,
  ].join("\n");
}

let input: any = {};
try {
  const text = await Bun.stdin.text();
  if (text.trim().length > 0) {
    input = JSON.parse(text);
  }
} catch {
  // empty / invalid stdin
}

const isStopHook = input.terminationReason !== undefined || input.executionNum !== undefined;
const messages = await drain();

if (messages.length === 0) {
  if (isStopHook) {
    console.log(JSON.stringify({ decision: "allow" }));
  } else {
    console.log(JSON.stringify({ injectSteps: [] }));
  }
  process.exit(0);
}

const rendered = render(messages);

if (isStopHook) {
  console.log(
    JSON.stringify({
      decision: "continue",
      reason: rendered,
    })
  );
} else {
  console.log(
    JSON.stringify({
      injectSteps: [
        {
          ephemeralMessage: rendered,
        },
      ],
    })
  );
}
