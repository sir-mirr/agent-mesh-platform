/**
 * What an env file is allowed to change, and what it must not.
 *
 * This was eleven lines running at `main.ts`'s module scope — before any test
 * could import the module, let alone reach them. It parses a format, decides a
 * precedence, and swallows every error, and none of those three had ever been
 * asked a question.
 *
 * The precedence is the part that matters. A file that could override the
 * process's environment would silently beat systemd's `EnvironmentFile`, and
 * the symptom is a service running with settings nobody can find by reading
 * the unit.
 */
import { describe, expect, test } from "bun:test";

import { ENV_FILE_VARS, loadEnvFile, parseEnvFile } from "./env-file";

describe("reading the format", () => {
  test("takes a key and everything after the first equals", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual([["A", "1"], ["B", "two"]]);
  });

  /** A value may contain `=` — a base64 key ends in them. */
  test("splits on the first equals and not the rest", () => {
    expect(parseEnvFile("VAPID_PRIVATE_KEY=abc=def==")).toEqual([["VAPID_PRIVATE_KEY", "abc=def=="]]);
  });

  test("skips blank lines and comments", () => {
    expect(parseEnvFile("\n# a note\n   \nA=1\n\t\n#B=2\n")).toEqual([["A", "1"]]);
  });

  /** `#` is only a comment at the start of a line. `hunter#2` is a password. */
  test("keeps a hash inside a value", () => {
    expect(parseEnvFile("PASSWORD=hunter#2")).toEqual([["PASSWORD", "hunter#2"]]);
  });

  /**
   * `> 0`, not `>= 0`. A line beginning with `=` has no key to set, and a line
   * with no `=` at all is not a setting — both are skipped rather than turned
   * into an empty-named variable.
   */
  test("skips a line with no key and a line with no equals", () => {
    expect(parseEnvFile("=orphan\nJUST_A_WORD\n=\nA=1")).toEqual([["A", "1"]]);
  });

  /** An empty value is a value: `A=` sets `A` to the empty string. */
  test("reads an empty value as empty rather than as absent", () => {
    expect(parseEnvFile("A=")).toEqual([["A", ""]]);
  });

  /** CRLF is trimmed with the rest of the line, so the value has no `\r` on it. */
  test("survives a file written on Windows", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual([["A", "1"], ["B", "2"]]);
  });

  /**
   * **Measured, not desired.** Only the whole line is trimmed, so spaces around
   * the `=` end up in the key and the value. Written down because it is the
   * kind of thing a later reader would "fix" — and fixing it changes what every
   * existing file means.
   */
  test("does not trim around the equals", () => {
    expect(parseEnvFile("A = b")).toEqual([["A ", " b"]]);
  });

  test("does not strip quotes, and does not read escapes", () => {
    expect(parseEnvFile('A="quoted"\nB=line\\nbreak')).toEqual([
      ["A", '"quoted"'], ["B", "line\\nbreak"],
    ]);
  });

  /** No `export` prefix. It is not a shell script. */
  test("does not understand a shell export", () => {
    expect(parseEnvFile("export A=1")).toEqual([["export A", "1"]]);
  });

  test("reads nothing out of nothing", () => {
    expect(parseEnvFile("")).toEqual([]);
  });
});

describe("what it is allowed to change", () => {
  const reader = (text: string) => (path: string) => {
    if (path !== "/env") throw new Error(`unexpected read: ${path}`);
    return text;
  };

  /** Opt-in. Naming no file means reading no file. */
  test("reads nothing when neither variable is set", () => {
    const env: Record<string, string | undefined> = { EXISTING: "kept" };
    loadEnvFile(env, () => { throw new Error("should not have read anything"); });
    expect(env).toEqual({ EXISTING: "kept" });
  });

  test("fills what the environment does not have", () => {
    const env: Record<string, string | undefined> = { AGENT_MESH_ENV_FILE: "/env" };
    loadEnvFile(env, reader("PORT=3000\nHUB=ws://x"));
    expect(env.PORT).toBe("3000");
    expect(env.HUB).toBe("ws://x");
  });

  /**
   * **The environment wins.** A file that overrode it would silently beat the
   * deployment's own configuration, and the symptom is a service running with
   * settings nobody can find by reading the unit.
   */
  test("never replaces something the process was already given", () => {
    const env: Record<string, string | undefined> = {
      AGENT_MESH_ENV_FILE: "/env", JWT_SECRET: "from-systemd",
    };
    loadEnvFile(env, reader("JWT_SECRET=from-the-file\nOTHER=set"));
    expect(env.JWT_SECRET).toBe("from-systemd");
    expect(env.OTHER).toBe("set");
  });

  /**
   * A variable explicitly set to empty *is* filled from the file, because the
   * guard is falsiness rather than presence. Measured rather than argued for —
   * an empty string in the environment is more often an accident than a
   * decision, and this is what the code does.
   */
  test("treats an empty variable as one that is not set", () => {
    const env: Record<string, string | undefined> = { AGENT_MESH_ENV_FILE: "/env", BLANK: "" };
    loadEnvFile(env, reader("BLANK=filled"));
    expect(env.BLANK).toBe("filled");
  });

  /** The first variable wins, and the second is the fallback rather than a second file. */
  test("prefers AGENT_MESH_ENV_FILE and falls back to the http-specific one", () => {
    expect(ENV_FILE_VARS).toEqual(["AGENT_MESH_ENV_FILE", "AGENT_MESH_HTTP_ENV_FILE"]);

    const both: Record<string, string | undefined> = {
      AGENT_MESH_ENV_FILE: "/env", AGENT_MESH_HTTP_ENV_FILE: "/other",
    };
    loadEnvFile(both, reader("WHICH=general"));   // reader refuses any path but /env
    expect(both.WHICH).toBe("general");

    const fallback: Record<string, string | undefined> = { AGENT_MESH_HTTP_ENV_FILE: "/env" };
    loadEnvFile(fallback, reader("WHICH=specific"));
    expect(fallback.WHICH).toBe("specific");
  });

  /**
   * **Optional means optional.** Failing startup over an absent convenience
   * would make the convenience a requirement — and this runs before anything
   * else in the process, so throwing here takes the service down with no route
   * having been registered.
   */
  test("says nothing when the file cannot be read", () => {
    const env: Record<string, string | undefined> = { AGENT_MESH_ENV_FILE: "/env" };
    expect(() => loadEnvFile(env, () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    })).not.toThrow();
    expect(env).toEqual({ AGENT_MESH_ENV_FILE: "/env" });
  });

  /** Whatever was set before the failure stays set — it fills as it goes. */
  test("keeps what it read before a reader gave up", () => {
    const env: Record<string, string | undefined> = { AGENT_MESH_ENV_FILE: "/env" };
    let calls = 0;
    loadEnvFile(env, (p) => { calls++; return reader("A=1\nB=2")(p); });
    expect({ calls, A: env.A, B: env.B }).toEqual({ calls: 1, A: "1", B: "2" });
  });
});
