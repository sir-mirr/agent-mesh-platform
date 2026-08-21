import { describe, expect, test, beforeEach } from "bun:test";
import {
  COUNTING_SINCE,
  consoleSink,
  createLogger,
  createRecordingLogger,
  startCounterHeartbeat,
  eventCounts,
  resetCountsForTest,
  type Level,
  type LoggedEvent,
  type Sink,
} from "./index";

/**
 * A sink that keeps what was written and which stream it went to, so a test
 * reads the line an operator would read rather than a mock's call record.
 */
function recorder(): Sink & { out_lines: string[]; err_lines: string[]; all(): string[] } {
  const out_lines: string[] = [];
  const err_lines: string[] = [];
  return {
    out_lines,
    err_lines,
    out: (line) => out_lines.push(line),
    err: (line) => err_lines.push(line),
    all: () => [...out_lines, ...err_lines],
  };
}

/** The JSON tail of a rendered line, parsed back. */
function payloadOf(line: string): LoggedEvent {
  const brace = line.indexOf(" {");
  return JSON.parse(line.slice(brace + 1)) as LoggedEvent;
}

const clock = (stamp = "2026-08-22T05:00:00.000Z") => () => stamp;

beforeEach(() => {
  resetCountsForTest();
});

describe("the line an operator reads", () => {
  test("leads with time, level, component and the sentence", () => {
    const sink = recorder();
    createLogger("hub", sink, clock()).error("send refused: no egress rule", "send_refused", {
      id: "msg-1",
      actor: "client-a",
      reason: "no_egress_rule",
    });

    const [line] = sink.err_lines;
    expect(line).toStartWith("2026-08-22T05:00:00.000Z error [hub] send refused: no egress rule {");
  });

  test("carries the same event as fields after the sentence", () => {
    const sink = recorder();
    createLogger("hub", sink, clock()).error("send refused", "send_refused", {
      id: "msg-1",
      actor: "client-a",
      outcome: "refused",
      reason: "no_egress_rule",
    });

    expect(payloadOf(sink.err_lines[0]!)).toEqual({
      ts: "2026-08-22T05:00:00.000Z",
      level: "error",
      component: "hub",
      event: "send_refused",
      id: "msg-1",
      actor: "client-a",
      outcome: "refused",
      reason: "no_egress_rule",
    });
  });

  test("repeats ts, level and component in the payload so a parser needs no split", () => {
    const sink = recorder();
    createLogger("self-reminder", sink, clock()).warn("hub closed the socket", "hub_closed");

    const payload = payloadOf(sink.err_lines[0]!);
    expect(payload.ts).toBe("2026-08-22T05:00:00.000Z");
    expect(payload.level).toBe("warn");
    expect(payload.component).toBe("self-reminder");
  });

  test("takes the clock at emit, not at construction", () => {
    const sink = recorder();
    const stamps = ["2026-08-22T05:00:00.000Z", "2026-08-22T05:00:01.000Z"];
    let n = 0;
    const log = createLogger("hub", sink, () => stamps[n++]!);

    log.info("first", "tick");
    log.info("second", "tick");

    expect(payloadOf(sink.out_lines[0]!).ts).toBe(stamps[0]!);
    expect(payloadOf(sink.out_lines[1]!).ts).toBe(stamps[1]!);
  });

  test("carries fields the type does not name", () => {
    const sink = recorder();
    createLogger("http", sink, clock()).info("push accepted", "push_accepted", {
      id: "sub-3",
      status: 201,
      endpoint_host: "push.example",
    });

    expect(payloadOf(sink.out_lines[0]!)).toMatchObject({ status: 201, endpoint_host: "push.example" });
  });

  test("names its component to a caller", () => {
    expect(createLogger("hub", recorder()).component).toBe("hub");
  });
});

describe("streams", () => {
  test("error and warn go to stderr, info to stdout", () => {
    const sink = recorder();
    const log = createLogger("hub", sink, clock());

    log.error("broke", "e");
    log.warn("odd", "w");
    log.info("fine", "i");

    expect(sink.err_lines.map((l) => payloadOf(l).level)).toEqual(["error", "warn"]);
    expect(sink.out_lines.map((l) => payloadOf(l).level)).toEqual(["info"]);
  });

  test("the default sink is the console", () => {
    const written: Array<[string, string]> = [];
    const log = console.log;
    const err = console.error;
    console.log = (line: string) => written.push(["out", line]);
    console.error = (line: string) => written.push(["err", line]);
    try {
      const logger = createLogger("hub", consoleSink, clock());
      logger.info("fine", "i");
      logger.error("broke", "e");
    } finally {
      console.log = log;
      console.error = err;
    }

    expect(written.map(([stream]) => stream)).toEqual(["out", "err"]);
    expect(written[0]![1]).toContain("[hub] fine");
    expect(written[1]![1]).toContain("[hub] broke");
  });
});

describe("the counter is the line's shadow", () => {
  test("every emitted line is counted once", () => {
    const log = createLogger("hub", recorder(), clock());

    log.error("a", "send_refused", { reason: "no_egress_rule" });
    log.error("a", "send_refused", { reason: "no_egress_rule" });
    log.warn("b", "frame_dropped", { reason: "socket_closed" });

    expect(eventCounts()).toEqual([
      { component: "hub", event: "send_refused", reason: "no_egress_rule", count: 2 },
      { component: "hub", event: "frame_dropped", reason: "socket_closed", count: 1 },
    ]);
  });

  test("counts by component, event and reason separately", () => {
    createLogger("hub", recorder(), clock()).warn("a", "frame_dropped", { reason: "socket_closed" });
    createLogger("http", recorder(), clock()).warn("a", "frame_dropped", { reason: "socket_closed" });

    expect(eventCounts().map((c) => c.component).sort()).toEqual(["http", "hub"]);
  });

  test("an event with no reason counts under the empty reason", () => {
    createLogger("hub", recorder(), clock()).info("registered", "hub_registered");

    expect(eventCounts()).toEqual([
      { component: "hub", event: "hub_registered", reason: "", count: 1 },
    ]);
  });

  test("orders most frequent first", () => {
    const log = createLogger("hub", recorder(), clock());
    log.warn("a", "rare");
    for (let i = 0; i < 3; i++) log.warn("b", "common");

    expect(eventCounts().map((c) => c.event)).toEqual(["common", "rare"]);
  });

  test("orders ties by component, then event, then reason", () => {
    const hub = createLogger("hub", recorder(), clock());
    const http = createLogger("http", recorder(), clock());
    http.warn("x", "b_event", { reason: "z" });
    hub.warn("x", "b_event", { reason: "a" });
    hub.warn("x", "a_event", { reason: "z" });
    hub.warn("x", "b_event", { reason: "b" });

    expect(eventCounts().map((c) => `${c.component} ${c.event} ${c.reason}`)).toEqual([
      "http b_event z",
      "hub a_event z",
      "hub b_event a",
      "hub b_event b",
    ]);
  });

  test("a zero is readable because the process says when it started counting", () => {
    expect(COUNTING_SINCE).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isFinite(Date.parse(COUNTING_SINCE))).toBe(true);
  });

  test("an empty count map is the answer before anything is logged", () => {
    expect(eventCounts()).toEqual([]);
  });
});

describe("the key cannot grow with traffic", () => {
  test("an unbounded reason counts as other and is still printed in full", () => {
    const sink = recorder();
    const log = createLogger("hub", sink, clock());
    const fromCaller = "no route for agent 4f9c-" + "a".repeat(200);

    log.error("send refused", "send_refused", { reason: fromCaller });

    expect(eventCounts()).toEqual([
      { component: "hub", event: "send_refused", reason: "other", count: 1 },
    ]);
    expect(payloadOf(sink.err_lines[0]!).reason).toBe(fromCaller);
  });

  test("many distinct unbounded reasons make one key", () => {
    const log = createLogger("hub", recorder(), clock());
    for (let i = 0; i < 50; i++) log.error("refused", "send_refused", { reason: `request ${i}` });

    expect(eventCounts()).toEqual([
      { component: "hub", event: "send_refused", reason: "other", count: 50 },
    ]);
  });

  test("a reason that is not a string counts as other", () => {
    const log = createLogger("hub", recorder(), clock());
    log.error("refused", "send_refused", { reason: 500 as unknown as string });

    expect(eventCounts()[0]!.reason).toBe("other");
  });

  test("a space in a reason cannot forge a second key", () => {
    const log = createLogger("hub", recorder(), clock());
    log.error("refused", "send_refused", { reason: "spoof other x" });

    expect(eventCounts()).toEqual([
      { component: "hub", event: "send_refused", reason: "other", count: 1 },
    ]);
  });

  test("accepts the token shapes this repository writes", () => {
    const log = createLogger("hub", recorder(), clock());
    for (const reason of ["no_egress_rule", "http.410", "db:full", "wal-recovery", "e2"]) {
      log.warn("x", "checked", { reason });
    }

    expect(eventCounts().map((c) => c.reason).sort()).toEqual(
      ["db:full", "e2", "http.410", "no_egress_rule", "wal-recovery"],
    );
  });

  test("a 64-character token is a token and a 65-character one is not", () => {
    const log = createLogger("hub", recorder(), clock());
    log.warn("x", "at_limit", { reason: "a".repeat(64) });
    log.warn("x", "over_limit", { reason: "b".repeat(65) });

    const byEvent = new Map(eventCounts().map((c) => [c.event, c.reason]));
    expect(byEvent.get("at_limit")).toBe("a".repeat(64));
    expect(byEvent.get("over_limit")).toBe("other");
  });

  test("a token cannot start with punctuation", () => {
    createLogger("hub", recorder(), clock()).warn("x", "e", { reason: "_leading" });

    expect(eventCounts()[0]!.reason).toBe("other");
  });
});

describe("levels", () => {
  test("each level names itself in the line and the payload", () => {
    const sink = recorder();
    const log = createLogger("hub", sink, clock());
    log.error("a", "e");
    log.warn("b", "w");
    log.info("c", "i");

    for (const [line, level] of [
      [sink.err_lines[0]!, "error"],
      [sink.err_lines[1]!, "warn"],
      [sink.out_lines[0]!, "info"],
    ] as Array<[string, Level]>) {
      expect(line).toContain(` ${level} [hub] `);
      expect(payloadOf(line).level).toBe(level);
    }
  });

  test("a caller-supplied level field cannot override the method", () => {
    const sink = recorder();
    createLogger("hub", sink, clock()).info("quiet", "tick", { level: "error" });

    expect(sink.err_lines).toEqual([]);
    expect(payloadOf(sink.out_lines[0]!).level).toBe("info");
  });

  test("a caller cannot restamp the clock or rename the component", () => {
    const sink = recorder();
    createLogger("hub", sink, clock()).warn("odd", "checked", {
      ts: "1999-01-01T00:00:00.000Z",
      component: "not-hub",
      event: "not_checked",
      id: "kept",
    });

    expect(payloadOf(sink.err_lines[0]!)).toEqual({
      ts: "2026-08-22T05:00:00.000Z",
      level: "warn",
      component: "hub",
      event: "checked",
      id: "kept",
    });
  });

  test("the counter keys on the logger's event, not the caller's", () => {
    createLogger("hub", recorder(), clock()).warn("odd", "checked", { event: "not_checked" });

    expect(eventCounts()).toEqual([
      { component: "hub", event: "checked", reason: "", count: 1 },
    ]);
  });
});

describe("the recording logger a test uses", () => {
  test("reads back the two halves of a line it really rendered", () => {
    const log = createRecordingLogger("hub", clock());
    log.error("send refused: no egress rule", "send_refused", { id: "msg-1", reason: "no_egress_rule" });

    expect(log.lines).toEqual([
      {
        line: log.lines[0]!.line,
        stream: "err",
        sentence: "send refused: no egress rule",
        event: {
          ts: "2026-08-22T05:00:00.000Z",
          level: "error",
          component: "hub",
          event: "send_refused",
          id: "msg-1",
          reason: "no_egress_rule",
        },
      },
    ]);
    expect(log.lines[0]!.line).toStartWith(
      "2026-08-22T05:00:00.000Z error [hub] send refused: no egress rule {",
    );
  });

  test("keeps the stream each line went to", () => {
    const log = createRecordingLogger("hub", clock());
    log.info("up", "started");
    log.warn("odd", "checked");

    expect(log.lines.map((l) => l.stream)).toEqual(["out", "err"]);
  });

  test("selects by event name, and returns everything without one", () => {
    const log = createRecordingLogger("hub", clock());
    log.info("a", "wanted");
    log.info("b", "other");
    log.info("c", "wanted");

    expect(log.recorded("wanted").map((l) => l.sentence)).toEqual(["a", "c"]);
    expect(log.recorded().length).toBe(3);
  });

  test("splits on the last tail, so a sentence quoting one survives", () => {
    const log = createRecordingLogger("hub", clock());
    log.warn('rejected a body starting {"ts":"1999" — not ours', "checked", { id: "x" });

    expect(log.lines[0]!.sentence).toBe('rejected a body starting {"ts":"1999" — not ours');
    expect(log.lines[0]!.event.id).toBe("x");
  });

  test("counts what it records, like any other logger", () => {
    const log = createRecordingLogger("self-reminder", clock());
    log.warn("held", "overdue_reminder_held", { reason: "awaiting_operator_decision" });

    expect(eventCounts()).toEqual([
      {
        component: "self-reminder",
        event: "overdue_reminder_held",
        reason: "awaiting_operator_decision",
        count: 1,
      },
    ]);
  });

  test("names its component like any other logger", () => {
    expect(createRecordingLogger("http").component).toBe("http");
  });
});

describe("saying what the counters hold", () => {
  /** A timer under the test's control, so nothing here waits fifteen minutes. */
  function fakeTimer() {
    const fired: Array<() => void> = [];
    let cleared = 0;
    return {
      fired,
      cleared: () => cleared,
      setTimer: (fn: () => void) => { fired.push(fn); return fired.length as unknown as ReturnType<typeof setInterval>; },
      clearTimer: () => { cleared += 1; },
    };
  }

  test("stamps the zero at boot next to the time counting began", () => {
    const log = createRecordingLogger("hub", clock());
    const timer = fakeTimer();
    startCounterHeartbeat(log, { setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    const [snapshot] = log.recorded("counter_snapshot");
    expect(snapshot!.event.since).toBe(COUNTING_SINCE);
    expect(snapshot!.event.counts).toEqual([]);
    expect(snapshot!.event.kinds).toBe(0);
    expect(snapshot!.stream).toBe("out");
  });

  test("reports what has been counted when the timer fires", () => {
    const log = createRecordingLogger("hub", clock());
    const timer = fakeTimer();
    startCounterHeartbeat(log, { setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    log.warn("refused", "send_refused", { reason: "egress_denied" });
    log.warn("refused", "send_refused", { reason: "egress_denied" });

    timer.fired[0]!();

    const snapshots = log.recorded("counter_snapshot");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.event.counts).toEqual([
      { component: "hub", event: "send_refused", reason: "egress_denied", count: 2 },
      { component: "hub", event: "counter_snapshot", reason: "", count: 1 },
    ]);
  });

  test("counts itself, which is one key and true", () => {
    const log = createRecordingLogger("hub", clock());
    const timer = fakeTimer();
    startCounterHeartbeat(log, { setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    timer.fired[0]!();
    timer.fired[0]!();

    expect(eventCounts()).toEqual([
      { component: "hub", event: "counter_snapshot", reason: "", count: 3 },
    ]);
  });

  test("stops when the caller stops it", () => {
    const log = createRecordingLogger("hub", clock());
    const timer = fakeTimer();
    const stop = startCounterHeartbeat(log, { setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    expect(timer.cleared()).toBe(0);
    stop();
    expect(timer.cleared()).toBe(1);
  });

  test("asks for the interval it was given", () => {
    const log = createRecordingLogger("hub", clock());
    const asked: number[] = [];
    startCounterHeartbeat(log, {
      intervalMs: 60_000,
      setTimer: ((fn: () => void, ms: number) => { asked.push(ms); return 1 as never; }) as never,
      clearTimer: () => {},
    });
    expect(asked).toEqual([60_000]);
  });

  test("defaults to a quarter of an hour", () => {
    const log = createRecordingLogger("hub", clock());
    const asked: number[] = [];
    startCounterHeartbeat(log, {
      setTimer: ((fn: () => void, ms: number) => { asked.push(ms); return 1 as never; }) as never,
      clearTimer: () => {},
    });
    expect(asked).toEqual([900_000]);
  });
});
