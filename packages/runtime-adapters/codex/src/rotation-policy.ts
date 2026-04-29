import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { TurnEnvelope } from "./turn-envelope";

export const R1_HANDOFF_PROMPT = [
  "<system>",
  "[bridge rotation] 당신의 thread가 교체 직전입니다. 이번 한 turn으로 다음을 응답해주세요:",
  "",
  "1) 현재 진행 중인 작업 (완료/중단/대기 구분)",
  "2) 중요한 의사결정·합의 사항",
  "3) 다음 thread에서 이어받아야 할 컨텍스트·링크",
  "",
  "제약:",
  "- 20줄 이내, 간결한 markdown",
  "- 서론·끝맺음 인사 생략",
  "- sentinel 토큰 사용 금지 (대괄호 2겹 제어 토큰)",
  "",
  "이 응답은 handoff 파일에 저장되어 다음 thread 첫 system 메시지로 주입됩니다.",
  "</system>",
].join("\n");

export function renderR3Prompt(handoffPath: string, handoffBody: string): string {
  return [
    "<system>",
    "[bridge rotation] 이전 thread에서 롤오버된 세션입니다. 이전 핸드오프:",
    "",
    `경로: ${handoffPath}`,
    "",
    "---",
    handoffBody,
    "---",
    "",
    '위 컨텍스트를 읽었다고 가정하고 이어서 응답해주세요. 이번 turn은 "ack: 핸드오프 확인 완료" 한 줄로만 응답하면 충분합니다. 이후 사용자 메시지가 오면 이 맥락을 기반으로 답변하세요.',
    "</system>",
  ].join("\n");
}

export function renderR3FallbackPrompt(): string {
  return [
    "<system>",
    "[bridge rotation] 이전 thread 핸드오프 저장에 실패했습니다 (turn/failed 또는 파일 쓰기 오류).",
    "이전 thread의 컨텍스트는 복원되지 않습니다. 새 thread로 시작합니다.",
    '이번 turn은 "ack: 새 thread 시작" 한 줄로만 응답해주세요. 이후 사용자 메시지가 오면 그대로 응답하세요.',
    "</system>",
  ].join("\n");
}

function newTurnId(): string {
  return `turn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function buildR1Envelope(): TurnEnvelope {
  return {
    turnId: newTurnId(),
    inputItems: [{ type: "text", text: R1_HANDOFF_PROMPT }],
    replyRoute: { kind: "none" },
    sourceMeta: {
      primarySource: "self-reminder",
      enqueuedAt: new Date().toISOString(),
      steerAppends: 0,
      isRotation: true,
      rotationStage: "r1-handoff-request",
    },
  };
}

export function buildR3Envelope(params: {
  handoffPath?: string;
  handoffBody?: string;
}): TurnEnvelope {
  const text =
    params.handoffPath && params.handoffBody
      ? renderR3Prompt(params.handoffPath, params.handoffBody)
      : renderR3FallbackPrompt();
  return {
    turnId: newTurnId(),
    inputItems: [{ type: "text", text }],
    replyRoute: { kind: "none" },
    sourceMeta: {
      primarySource: "self-reminder",
      enqueuedAt: new Date().toISOString(),
      steerAppends: 0,
      isRotation: true,
      rotationStage: "r3-hint-injection",
    },
  };
}

export type PersistTurnCountFn = (turnCount: number) => void;

export interface RotationPolicyOptions {
  enabled: boolean;
  turnThreshold: number;
  handoffDir: string;
  persistTurnCount: PersistTurnCountFn;
}

export class RotationPolicy {
  private turnCount = 0;
  private inProgress = false;
  private pendingHandoffPath: string | null = null;
  private pendingHandoffBody: string | null = null;

  constructor(private readonly opts: RotationPolicyOptions) {}

  setInitialTurnCount(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      this.turnCount = 0;
      return;
    }
    this.turnCount = Math.floor(value);
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  isRotationInProgress(): boolean {
    return this.inProgress;
  }

  resetOnThreadChange(): void {
    if (this.turnCount === 0) return;
    this.turnCount = 0;
    this.opts.persistTurnCount(this.turnCount);
  }

  incrementTurn(): void {
    if (!this.opts.enabled) return;
    this.turnCount += 1;
    this.opts.persistTurnCount(this.turnCount);
  }

  shouldTriggerRotation(): boolean {
    if (!this.opts.enabled || this.inProgress) return false;
    return this.turnCount >= this.opts.turnThreshold;
  }

  markRotationStart(): void {
    this.inProgress = true;
  }

  markRotationEnd(): void {
    this.inProgress = false;
    this.pendingHandoffPath = null;
    this.pendingHandoffBody = null;
  }

  saveHandoff(params: {
    oldThreadId: string | null;
    body: string;
    turnCountAtRotation: number;
  }): { path: string; body: string } | null {
    const body = params.body.trim();
    if (!body) return null;
    try {
      mkdirSync(this.opts.handoffDir, { recursive: true });
    } catch {
      return null;
    }
    const now = new Date();
    const threadShort = (params.oldThreadId ?? "unknown").slice(0, 8);
    const filename = `${formatTimestamp(now)}-${threadShort}.md`;
    const path = `${this.opts.handoffDir.replace(/\/$/, "")}/${filename}`;
    const frontMatter =
      `---\n` +
      `threadId: ${params.oldThreadId ?? "(unknown)"}\n` +
      `rotatedAt: ${now.toISOString()}\n` +
      `turnCount: ${params.turnCountAtRotation}\n` +
      `---\n\n`;
    try {
      writeFileSync(path, frontMatter + body + "\n", "utf8");
      this.pendingHandoffPath = path;
      this.pendingHandoffBody = body;
      return { path, body };
    } catch {
      return null;
    }
  }

  getPendingHandoff(): { path: string; body: string } | null {
    if (this.pendingHandoffPath && this.pendingHandoffBody) {
      return { path: this.pendingHandoffPath, body: this.pendingHandoffBody };
    }
    return null;
  }
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
