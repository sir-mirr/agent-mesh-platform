import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DICTIONARY } from "@/contexts/I18nContext.tsx";
import { CAPABILITY } from "@/types/auth.ts";

/**
 * Machine vocabulary belongs in contracts, comments and diagnostics. The copy
 * below is what the operator actually sees, so a person opening the console
 * must be able to understand it without the protocol specification beside it.
 *
 * These patterns were taken from the strings that were on screen when this
 * guard was introduced. Keeping that provenance matters: a guessed blacklist
 * would both miss the real leak and reject ordinary language by accident.
 */
const FORBIDDEN_COPY = [
  { name: "specification section", pattern: /\bSPEC\s*§|§\s*\d/iu },
  { name: "server redaction token", pattern: /\[content withheld[^\]]*\]/iu },
  { name: "delivery protocol term", pattern: /\b(?:TTL|ACK|NACK|Ed25519|At-Least-Once|Available|Leased|Acked|lease|leases)\b|리스/iu },
  { name: "unimplemented infrastructure claim", pattern: /mTLS|CPU\s*[,/&·]\s*(?:RAM|Memory)|글로벌 분산|테넌트 트래픽 격리|tenant traffic isolation|Buffer Normal|정상 버퍼/iu },
  { name: "misnamed screen", pattern: /Node Telemetry|노드 텔레메트리|Tenant Routing|테넌트 라우팅/iu },
] as const;

const WEB = import.meta.dir;
const UI_ROOTS = ["components", "contexts", "pages"];

function runtimeUiFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return runtimeUiFiles(full);
    return /\.tsx?$/.test(full) && !/\.test\.|\/PROBE\./.test(full) ? [full] : [];
  });
}

/** Translation fallbacks and JSX attributes, excluding identifiers and comments. */
function displayStrings(line: string): string[] {
  if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return [];
  const quoted = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)];
  return quoted
    .filter((match) => /\s/.test(match[0]))
    .map((match) => match[0].slice(1, -1));
}

describe("operator-facing vocabulary", () => {
  it("contains no specification citations, machine keys, tokens, or unimplemented concepts", () => {
    const leaks: string[] = [];
    for (const [language, dictionary] of Object.entries(DICTIONARY)) {
      for (const [key, value] of Object.entries(dictionary)) {
        for (const forbidden of FORBIDDEN_COPY) {
          if (forbidden.pattern.test(value)) {
            leaks.push(`${language}.${key}: ${forbidden.name}: ${value}`);
          }
        }
        for (const capability of Object.values(CAPABILITY)) {
          if (value.includes(capability)) {
            leaks.push(`${language}.${key}: machine capability key: ${value}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("keeps scenario ids and invented role badges out of the page chrome", async () => {
    const sources = await Promise.all([
      Bun.file(new URL("./components/layout/PageHeader.tsx", import.meta.url)).text(),
      Bun.file(new URL("./pages/DashboardPage.tsx", import.meta.url)).text(),
    ]);
    const chrome = sources.join("\n");
    expect(chrome).not.toMatch(/Screen #/u);
    expect(chrome).not.toMatch(/["'][^"'\n]*(?:ADMIN MASTER|PLATFORM OPERATOR|STUDIO SUITE|TENANT ADMIN)[^"'\n]*["']/u);
  });

  it("also guards runtime fallbacks and JSX labels outside the dictionary", () => {
    const leaks: string[] = [];
    const files = UI_ROOTS.flatMap((dir) => runtimeUiFiles(join(WEB, dir)));
    for (const file of files) {
      const relative = file.slice(WEB.length + 1);
      for (const [lineIndex, line] of readFileSync(file, "utf8").split("\n").entries()) {
        for (const value of displayStrings(line)) {
          for (const forbidden of FORBIDDEN_COPY) {
            if (forbidden.pattern.test(value)) {
              leaks.push(`${relative}:${lineIndex + 1}: ${forbidden.name}: ${value}`);
            }
          }
          for (const capability of Object.values(CAPABILITY)) {
            if (value.includes(capability)) {
              leaks.push(`${relative}:${lineIndex + 1}: machine capability key: ${value}`);
            }
          }
        }
      }
    }
    expect(files.length).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
  });
});
