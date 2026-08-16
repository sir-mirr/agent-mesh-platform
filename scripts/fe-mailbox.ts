#!/usr/bin/env bun
/**
 * Mailbox helper for platform-fe-antigravity.
 *
 * Usage:
 *   bun scripts/fe-mailbox.ts check           # Check and drain new mail (advances high-water mark)
 *   bun scripts/fe-mailbox.ts peek            # Peek all messages without modifying mark
 *   bun scripts/fe-mailbox.ts send <to> [body] # Send mail to target agent (reads stdin if body omitted)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAILBOX = process.env.AGENT_MESH_MAILBOX_URL ?? "http://localhost:3300/api/mail";
const AGENT_ID = "platform-fe-antigravity";
const TIMEOUT_MS = 3000;

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
    // Unwritable state means the next run replays.
  }
}

async function fetchMessages(): Promise<Mail[]> {
  const url = `${MAILBOX}?agentId=${encodeURIComponent(AGENT_ID)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`Mailbox returned status ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { messages?: Mail[] };
    return data.messages ?? [];
  } catch (err: any) {
    console.error(`Failed to reach mailbox at ${url}:`, err?.message ?? err);
    return [];
  }
}

async function check(): Promise<void> {
  const messages = await fetchMessages();
  if (messages.length === 0) {
    console.log(`[fe-mailbox] No messages in mailbox for ${AGENT_ID}.`);
    return;
  }

  const mark = readMark();
  const fresh =
    mark === null
      ? messages.filter((m) => m.isRead !== true)
      : messages.filter((m) => m.id > mark);

  const highest = messages.reduce((max, m) => (m.id > max ? m.id : max), mark ?? 0);
  writeMark(highest);

  if (fresh.length === 0) {
    console.log(`[fe-mailbox] No new messages (high-water mark: #${mark}).`);
    return;
  }

  console.log(`[fe-mailbox] Received ${fresh.length} new message(s):`);
  for (const m of fresh.sort((a, b) => a.id - b.id)) {
    const when = new Date(m.createdAt).toISOString();
    console.log(`\n============================================================`);
    console.log(`Mail #${m.id} | From: ${m.from} -> To: ${m.to} | At: ${when}`);
    console.log(`============================================================`);
    console.log(m.body);
  }
}

async function peek(): Promise<void> {
  const messages = await fetchMessages();
  const mark = readMark();
  console.log(`[fe-mailbox] Total messages: ${messages.length}, current high-water mark: ${mark}`);
  for (const m of messages) {
    const when = new Date(m.createdAt).toISOString();
    const isNew = mark === null ? !m.isRead : m.id > mark;
    console.log(`\n#${m.id} [${isNew ? "NEW" : "SEEN"}] From: ${m.from} | At: ${when}`);
    console.log(m.body);
  }
}

async function sendMail(to: string, bodyText?: string): Promise<void> {
  let body = bodyText;
  if (!body) {
    body = await Bun.stdin.text();
  }
  if (!body || body.trim().length === 0) {
    console.error("Error: Message body is empty.");
    process.exit(1);
  }

  try {
    const res = await fetch(MAILBOX, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: AGENT_ID,
        to,
        body,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`Failed to send mail: HTTP ${res.status}`);
      process.exit(1);
    }

    const result = await res.json();
    console.log(`[fe-mailbox] Sent mail #${result.id ?? "ok"} to ${to}`);
  } catch (err: any) {
    console.error("Error sending mail:", err?.message ?? err);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const command = args[0] ?? "check";

switch (command) {
  case "check":
    await check();
    break;
  case "peek":
    await peek();
    break;
  case "send": {
    const to = args[1] ?? "platform-claude";
    let body: string | undefined;
    if (args[2] === "--file" && args[3]) {
      body = readFileSync(args[3], "utf8");
    } else {
      body = args.slice(2).join(" ");
    }
    await sendMail(to, body || undefined);
    break;
  }
  default:
    console.log(`Unknown command: ${command}`);
    console.log(`Usage: bun scripts/fe-mailbox.ts [check|peek|send <to> [body | --file <path>]]`);
}
