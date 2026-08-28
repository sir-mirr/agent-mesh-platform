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
const fromCodePoints = (...points: number[]): string => String.fromCodePoint(...points);
const withTerms = (pattern: RegExp, ...terms: string[]): RegExp =>
  new RegExp(`${pattern.source}|${terms.join("|")}`, pattern.flags);
const DELIVERY_PROTOCOL_TERMS = [fromCodePoints(0xb9ac, 0xc2a4)];
const INFRASTRUCTURE_TERMS = [
  fromCodePoints(0xae00, 0xb85c, 0xbc8c, 0x20, 0xbd84, 0xc0b0),
  fromCodePoints(0xd14c, 0xb10c, 0xd2b8, 0x20, 0xd2b8, 0xb798, 0xd53d, 0x20, 0xaca9, 0xb9ac),
  fromCodePoints(0xc815, 0xc0c1, 0x20, 0xbc84, 0xd37c),
];
const MISNAMED_SCREEN_TERMS = [
  fromCodePoints(0xb178, 0xb4dc, 0x20, 0xd154, 0xb808, 0xba54, 0xd2b8, 0xb9ac),
  fromCodePoints(0xd14c, 0xb10c, 0xd2b8, 0x20, 0xb77c, 0xc6b0, 0xd305),
];

const FORBIDDEN_COPY = [
  { name: "specification section", pattern: /\bSPEC\s*§|§\s*\d/iu },
  { name: "server redaction token", pattern: /\[content withheld[^\]]*\]/iu },
  {
    name: "delivery protocol term",
    pattern: withTerms(
      /\b(?:TTL|ACK|NACK|Ed25519|At-Least-Once|Available|Leased|Acked|lease|leases)\b/iu,
      ...DELIVERY_PROTOCOL_TERMS,
    ),
  },
  {
    name: "unimplemented infrastructure claim",
    pattern: withTerms(
      /mTLS|CPU\s*[,/&·]\s*(?:RAM|Memory)|tenant traffic isolation|Buffer Normal/iu,
      ...INFRASTRUCTURE_TERMS,
    ),
  },
  {
    name: "misnamed screen",
    pattern: withTerms(
      /Node Telemetry|Tenant Routing/iu,
      ...MISNAMED_SCREEN_TERMS,
    ),
  },
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
  it("keeps every non-English forbidden term live in its guard", () => {
    const terms = [
      ["delivery protocol term", DELIVERY_PROTOCOL_TERMS],
      ["unimplemented infrastructure claim", INFRASTRUCTURE_TERMS],
      ["misnamed screen", MISNAMED_SCREEN_TERMS],
    ] as const;
    for (const [name, values] of terms) {
      const pattern = FORBIDDEN_COPY.find((entry) => entry.name === name)?.pattern;
      expect(pattern).toBeDefined();
      expect(values.filter((value) => !pattern!.test(value))).toEqual([]);
    }
  });

  it("applies the unified-registry person filter in every page that fetches agents", () => {
    const pages = runtimeUiFiles(join(WEB, "pages"));
    const consumers = pages
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => /\bfetchAgents\s*\(/u.test(source));
    const missing = consumers
      .filter(({ source }) => !/\b(?:agentRegistryEntries|callableAgentRegistryEntries|agentMemberIdentities)\s*\(/u.test(source))
      .map(({ file }) => file.slice(WEB.length + 1));

    // This is a screen-boundary rule, not a change to `/api/v1/agents`: every
    // page drawing an agent count, row, node, or picker must make the unified
    // response's `type: user` rows cross the shared filter first.
    expect(consumers.length).toBeGreaterThanOrEqual(5);
    expect(missing).toEqual([]);
  });

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
