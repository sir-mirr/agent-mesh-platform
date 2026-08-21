/**
 * Leaving cleanly, and leaving even when one store will not.
 *
 * The defect this guards was an omission rather than a bug:
 * `closeAuditAccessLog` was imported by `main.ts` and never called, so the
 * read-write handle on `audit.db` went out unfolded. Nothing detected it,
 * because an unclosed store looks exactly like a closed one until the next
 * process opens it and finds a write-ahead log nobody folded in.
 *
 * Two checks, and they answer different questions. The behaviour below asks
 * *what runShutdown does with a list*; the last one asks *whether the list is
 * the whole list*, which no runtime test can — an import that is never called
 * leaves no trace at runtime, which is precisely how the original went
 * unnoticed.
 *
 * This file owns the `sd-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { runShutdown, type Closer } from "./shutdown";

/** A shutdown that records what happened, in order, and never leaves. */
function wiring(over: Partial<Parameters<typeof runShutdown>[0]> = {}) {
  const steps: string[] = [];
  const warnings: string[] = [];
  const closers: Closer[] = [
    ["one", () => { steps.push("close one"); }],
    ["two", () => { steps.push("close two"); }],
  ];
  const w = {
    closers,
    stop: () => { steps.push("stop"); },
    exit: (code: number) => { steps.push(`exit ${code}`); },
    log: () => {},
    warn: (m: string) => { warnings.push(m); },
    ...over,
  };
  return { w, steps, warnings };
}

describe("closing up", () => {
  test("closes every store, then stops serving, then leaves", () => {
    const { w, steps } = wiring();
    runShutdown(w);
    expect(steps).toEqual(["close one", "close two", "stop", "exit 0"]);
  });

  /**
   * **Stores first, server second.** A request still in flight would otherwise
   * be answered by a handler whose database has already gone.
   */
  test("does not stop the server before the stores are closed", () => {
    const { w, steps } = wiring();
    runShutdown(w);
    expect(steps.indexOf("stop")).toBeGreaterThan(steps.indexOf("close two"));
  });

  /**
   * **One unclosable store must not cost the others theirs.** The calls used to
   * run in a row, so the first throw skipped every close after it *and* the
   * exit — leaving a process that had been asked to stop still running, for
   * systemd to `SIGKILL` after its timeout. That is the ungraceful ending the
   * closers exist to avoid, reached by way of the closers.
   */
  test("keeps closing after one refuses, and still leaves", () => {
    const { w, steps, warnings } = wiring({
      closers: [
        ["first", () => { steps.push("close first"); }],
        ["stubborn", () => { throw new Error("database is locked"); }],
        ["last", () => { steps.push("close last"); }],
      ],
    });
    runShutdown(w);
    expect(steps).toEqual(["close first", "close last", "stop", "exit 0"]);
    expect(warnings.join(" ")).toContain("stubborn");
  });

  /** A server that will not stop is not a reason to stay. */
  test("leaves even when the server will not stop", () => {
    const { w, steps, warnings } = wiring({
      stop: () => { throw new Error("already stopped"); },
    });
    runShutdown(w);
    expect(steps).toEqual(["close one", "close two", "exit 0"]);
    expect(warnings.join(" ")).toContain("stop");
  });

  /** `0`. Being asked to stop and stopping is not a failure. */
  test("leaves with the code that means nothing went wrong", () => {
    // Collected rather than assigned: TypeScript does not track a write that
    // happens inside a callback, so a plain `let` narrows to its initialiser.
    const codes: number[] = [];
    const { w } = wiring({ exit: (c: number) => { codes.push(c); } });
    runShutdown(w);
    expect(codes).toEqual([0]);
  });

  test("says it is shutting down before it starts", () => {
    const said: string[] = [];
    const { w } = wiring({ log: (m: string) => { said.push(m); } });
    runShutdown(w);
    expect(said[0]).toContain("shutting down");
  });

  /**
   * **The defaults are what production runs.** Every test above injects `log`
   * and `warn`, so the two lines the served process actually uses had never
   * been executed — a fallback nothing exercises is a fallback nobody has seen
   * work, which is the subject this whole file is an instance of.
   */
  test("says it on the console when nobody says where", () => {
    const realLog = console.log;
    const realErr = console.error;
    const said: string[] = [];
    console.log = (...a: unknown[]) => { said.push(`log ${a.join(" ")}`); };
    console.error = (...a: unknown[]) => { said.push(`err ${a[0]}`); };
    const steps: string[] = [];
    try {
      runShutdown({
        closers: [["stubborn", () => { throw new Error("locked"); }]],
        stop: () => { steps.push("stop"); },
        exit: (code) => { steps.push(`exit ${code}`); },
      });
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
    expect(steps).toEqual(["stop", "exit 0"]);
    expect(said[0]).toContain("shutting down");
    expect(said.join(" ")).toContain("could not close stubborn cleanly");
  });

  /** A deployment with nothing open still stops and leaves. */
  test("stops and leaves with no stores at all", () => {
    const { w, steps } = wiring({ closers: [] });
    runShutdown(w);
    expect(steps).toEqual(["stop", "exit 0"]);
  });
});

describe("whether the list is the whole list", () => {
  /**
   * **The question no runtime test can ask.** An import that is never called
   * leaves nothing behind at run time — which is how `closeAuditAccessLog`
   * stayed uncalled. So this reads the source: every `close*` the service
   * imports has to appear in the list it shuts down with.
   */
  test("every closer main.ts imports is one it closes", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url).pathname, "utf8");

    const imported = new Set<string>();
    for (const line of source.split("\n")) {
      if (!/^import .* from '\.\//.test(line)) continue;
      for (const m of line.matchAll(/\b(close[A-Z][A-Za-z]*)\b/g)) imported.add(m[1]!);
    }
    expect(imported.size).toBeGreaterThan(3);

    const list = /const SHUTDOWN_CLOSERS[\s\S]*?\n\]/.exec(source);
    expect(list, "the closer list moved or was renamed").not.toBeNull();
    const closed = new Set(
      [...list![0].matchAll(/\b(close[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]!),
    );

    expect([...imported].filter((c) => !closed.has(c))).toEqual([]);
    // And nothing in the list that the file does not import — a name that
    // resolves to nothing would be a closer that never ran either.
    expect([...closed].filter((c) => !imported.has(c))).toEqual([]);
  });
});
