/**
 * One log line shape for every service (T-022 section 2).
 *
 * Three services wrote three shapes: `[hub] <ISO> <sentence>`,
 * `[self-reminder <ISO>] <event> {json}`, and -- in the http server -- fifty
 * odd bare `console.log` calls with a bracketed subsystem, no level and no
 * clock. An operator reading one incident across two of them had to know all
 * three, and nothing machine-readable came out of any.
 *
 * ## A sentence for a person and fields for a program, in one call
 *
 * ```
 * 2026-08-22T05:00:00.000Z error [hub] send refused: no egress rule {"ts":"...","level":"error",...}
 * ```
 *
 * The head is what somebody reads in `journalctl -f`. The tail is the same
 * event as data, and it repeats `ts`, `level` and `component` on purpose: a
 * parser that takes the JSON gets the whole event without splitting the line
 * first, and the head is a *rendering* of that payload rather than a second
 * copy of it. Both come from one call, so they cannot drift.
 *
 * **Every failure names what, who and why** (principle 1). `id`, `actor` and
 * `reason` are the three fields a complaint is answered from, which is why
 * they are spelled out in the type rather than left to each caller.
 *
 * ## The counter is the log line's shadow
 *
 * Every logged event increments a counter keyed on
 * `(component, event, reason)`. Not a second API to keep in step -- there is
 * nothing to keep in step, because one call does both. A counter cannot
 * describe an event that is not logged, and a line cannot happen uncounted.
 *
 * This is what principle 3 asks for: *no logs* and *no problem* are the same
 * observation without it. A counter standing at zero since boot says the path
 * is alive and quiet; a counter that is not there says nobody looked.
 *
 * **Bounded by construction.** The key is `(component, event, reason)` and all
 * three come from the source. A `reason` that is not a short token -- anything
 * a caller could have built out of a request, or a database's error message --
 * is counted as `other` while the line still carries it in full. So the map
 * cannot grow past the vocabulary in the code however much traffic arrives,
 * and nothing an operator reads is lost. A counter map keyed on caller input
 * is a memory leak whose rate the caller chooses.
 *
 * ## Streams
 *
 * `error` and `warn` go to stderr, `info` to stdout. Both are the record --
 * journald keeps them with their priority and `test/harness.ts` concatenates
 * them -- and the split is what lets an operator ask *is anything wrong* by
 * looking at one of them. Ordering is guaranteed within a stream and not
 * between the two; that is the cost, and it is the smaller one, because a
 * normal path is silent (principle 2) and stdout is where a healthy service
 * says almost nothing.
 */

export type Level = "error" | "warn" | "info";

/**
 * The fields a complaint is answered from, plus whatever else the event has.
 *
 * All optional, because not every event has all of them -- but an event with
 * none of them is a sentence, and principle 1 is about that difference.
 */
export interface EventFields {
  /** The thing this is about: a message id, an identity, a fingerprint. */
  id?: string;
  /** Who caused it, when anybody did. */
  actor?: string;
  /** What became of it: `refused`, `delivered`, `dropped`, `queued`. */
  outcome?: string;
  /** Why, for anything that did not go through. A short token from the source. */
  reason?: string;
  [field: string]: unknown;
}

export interface LoggedEvent extends EventFields {
  ts: string;
  level: Level;
  component: string;
  event: string;
}

/** Where the lines go. Replaceable so a test can read what was written. */
export interface Sink {
  out(line: string): void;
  err(line: string): void;
}

/**
 * Drops the lines. For a default -- a service that was handed no sink is silent
 * rather than noisy -- and for a test that only reads the counters.
 *
 * The event is still counted. The sink decides where a line goes, including
 * nowhere; it does not decide whether the event happened.
 */
export const silentSink: Sink = { out: () => {}, err: () => {} };

export const consoleSink: Sink = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface Logger {
  readonly component: string;
  error(sentence: string, event: string, fields?: EventFields): void;
  warn(sentence: string, event: string, fields?: EventFields): void;
  info(sentence: string, event: string, fields?: EventFields): void;
}

/**
 * A `reason` may key a counter only if it is a token this repository could
 * have written. Anything else is counted as `other`.
 */
const BOUNDED_REASON = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

const counts = new Map<string, number>();

/**
 * When this process began counting.
 *
 * Without it a `0` cannot be read: "nothing has gone wrong" and "this process
 * started ninety seconds ago" produce the same number, and on a screen the
 * second one looks like health.
 */
export const COUNTING_SINCE = new Date().toISOString();

/** A space cannot appear in any of the three parts, so it separates them. */
const key = (component: string, event: string, reason: string) =>
  `${component} ${event} ${reason}`;

export interface EventCount {
  component: string;
  event: string;
  /** `""` for an event that carried no reason. */
  reason: string;
  count: number;
}

/** Every event counted since this process started, most frequent first. */
export function eventCounts(): EventCount[] {
  return [...counts.entries()]
    .map(([k, count]) => {
      const [component, event, reason] = k.split(" ") as [string, string, string];
      return { component, event, reason, count };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.component.localeCompare(b.component) ||
        a.event.localeCompare(b.event) ||
        a.reason.localeCompare(b.reason),
    );
}

/** For a test that needs to read its own counts without the run's history. */
export function resetCountsForTest(): void {
  counts.clear();
}

function render(payload: LoggedEvent, sentence: string): string {
  return `${payload.ts} ${payload.level} [${payload.component}] ${sentence} ${JSON.stringify(payload)}`;
}

export function createLogger(
  component: string,
  sink: Sink = consoleSink,
  now: () => string = () => new Date().toISOString(),
): Logger {
  const emit = (level: Level, sentence: string, event: string, fields: EventFields = {}): void => {
    // The four canonical fields belong to the logger, not to the caller. Taking
    // them out of `fields` first means a caller that happens to have its own
    // `level` or `component` cannot make the JSON tail disagree with the
    // sentence the head renders -- one call, one event, one level.
    const { ts: _ts, level: _level, component: _component, event: _event, ...rest } = fields;
    const payload: LoggedEvent = { ts: now(), level, component, event, ...rest };
    const stated = fields.reason;
    const reason =
      stated === undefined
        ? ""
        : typeof stated === "string" && BOUNDED_REASON.test(stated)
          ? stated
          : "other";
    const k = key(component, event, reason);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const line = render(payload, sentence);
    if (level === "info") sink.out(line);
    else sink.err(line);
  };

  return {
    component,
    error: (sentence, event, fields) => emit("error", sentence, event, fields),
    warn: (sentence, event, fields) => emit("warn", sentence, event, fields),
    info: (sentence, event, fields) => emit("info", sentence, event, fields),
  };
}

/**
 * Capture what a module-level logger writes, for a test that cannot inject one.
 *
 * `consoleSink` is the only route to the terminal, so both of its methods are
 * taken. A test that patched `console.warn` -- as several did while every
 * subsystem invented its own call -- now captures nothing, because `warn` goes
 * to stderr through `console.error` like any other line an operator wants
 * separated from the healthy ones.
 */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const take = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.log = take;
  console.error = take;
  return {
    lines,
    restore: () => { console.log = realLog; console.error = realError; },
  };
}

/** One line as it was written, plus the two halves read back apart. */
export interface RecordedLine {
  line: string;
  stream: "out" | "err";
  /** The half a person reads. */
  sentence: string;
  /** The half a program reads. */
  event: LoggedEvent;
}

export interface RecordingLogger extends Logger {
  readonly lines: RecordedLine[];
  /** Every line recorded, or only those for one event name. */
  recorded(event?: string): RecordedLine[];
}

/**
 * The JSON tail always begins here, and a sentence containing the same text
 * would still be split correctly because the *last* occurrence is taken.
 */
const TAIL = ' {"ts":"';

/**
 * A logger for a test, which renders exactly what production renders and then
 * reads it back apart.
 *
 * A test that captured `(event, fields)` before rendering would pass while the
 * line an operator sees is malformed -- which is the failure worth catching,
 * because the line is the artifact.
 */
export function createRecordingLogger(
  component: string,
  now: () => string = () => new Date().toISOString(),
): RecordingLogger {
  const lines: RecordedLine[] = [];
  const record = (stream: "out" | "err") => (line: string) => {
    const cut = line.lastIndexOf(TAIL);
    lines.push({
      line,
      stream,
      sentence: line.slice(line.indexOf(`[${component}] `) + component.length + 3, cut),
      event: JSON.parse(line.slice(cut + 1)) as LoggedEvent,
    });
  };
  const logger = createLogger(component, { out: record("out"), err: record("err") }, now);
  return {
    ...logger,
    lines,
    recorded: (event) => (event === undefined ? lines : lines.filter((l) => l.event.event === event)),
  };
}
