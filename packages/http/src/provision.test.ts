/**
 * Registering a person as a mesh identity (SPEC § 10.1, § 10.3).
 *
 * The half worth testing is what happens when the hub is not there or does not
 * agree, because an unregistered person still signs in, still sends and still
 * receives — the only trace is what this module reports, and until it was
 * exercised the reporting was the least-run code in the file.
 *
 * This file owns the `pv-` prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { provisionAllHumans, provisionHuman, restBase } from "./provision";

let n = 0;
const uniq = (p: string) => `pv-${p}-${++n}-${process.pid}`;

const realFetch = globalThis.fetch;
const realRest = process.env.AGENT_MESH_HUB_REST_URL;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realRest === undefined) delete process.env.AGENT_MESH_HUB_REST_URL;
  else process.env.AGENT_MESH_HUB_REST_URL = realRest;
});

/** Every call, and what it answered. */
function hub(respond: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
    return await respond(url);
  }) as typeof fetch;
  return calls;
}

const ok = () => new Response(null, { status: 201 });

describe("restBase", () => {
  test("a stated REST url wins, without its trailing slashes", () => {
    process.env.AGENT_MESH_HUB_REST_URL = "https://hub.example///";

    expect(restBase()).toBe("https://hub.example");
  });

  test("blank is not a statement", () => {
    process.env.AGENT_MESH_HUB_REST_URL = "   ";

    expect(restBase("ws://hub.example:3100/ws")).toBe("http://hub.example:3100");
  });

  test("derives the origin from the socket url, and upgrades wss to https", () => {
    delete process.env.AGENT_MESH_HUB_REST_URL;

    expect(restBase("ws://127.0.0.1:3100/ws")).toBe("http://127.0.0.1:3100");
    expect(restBase("wss://hub.example/ws")).toBe("https://hub.example");
  });

  test("a socket url that is not a url falls back to the local hub", () => {
    delete process.env.AGENT_MESH_HUB_REST_URL;

    expect(restBase("127.0.0.1:3100")).toBe("http://127.0.0.1:3100");
  });
});

describe("provisionHuman", () => {
  test("registers the login verbatim, as a human", async () => {
    const identity = uniq("Person");
    const calls = hub(() => ok());

    expect(await provisionHuman(identity)).toEqual({ ok: true });
    expect(calls[0]!.body).toEqual({ identity, type: "human", description: "Web user" });
  });

  test("a login § 10.1 would refuse is reported, not mangled to fit", async () => {
    const calls = hub(() => ok());

    const outcome = await provisionHuman("-leading-hyphen");

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("not a valid mesh identity");
    expect(calls).toHaveLength(0);
  });

  test("an unreachable hub is reported as unreachable", async () => {
    hub(() => { throw new Error("connect ECONNREFUSED"); });

    expect(await provisionHuman(uniq("Person"))).toEqual({
      ok: false,
      reason: "hub unreachable: connect ECONNREFUSED",
    });
  });

  test("a refusal carries the hub's own reason", async () => {
    hub(() => Response.json({ error: "identity is torn down" }, { status: 409 }));

    expect(await provisionHuman(uniq("Person"))).toEqual({
      ok: false,
      reason: "HTTP 409: identity is torn down",
    });
  });

  test("a refusal that says nothing is reported by its status", async () => {
    hub(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(await provisionHuman(uniq("Person"))).toEqual({ ok: false, reason: "HTTP 502" });
  });

  test("a JSON body with no error field adds nothing to the status", async () => {
    hub(() => Response.json({ detail: "unhelpful" }, { status: 500 }));

    expect(await provisionHuman(uniq("Person"))).toEqual({ ok: false, reason: "HTTP 500" });
  });
});

describe("provisionAllHumans", () => {
  test("nobody to register asks the hub nothing", async () => {
    const calls = hub(() => ok());

    await provisionAllHumans([]);

    expect(calls).toHaveLength(0);
  });

  test("names everyone it could not register, and why", async () => {
    const good = uniq("Good");
    const logs: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    hub((url) => url.endsWith("/api/v1/agents") ? Response.json({ error: "taken" }, { status: 409 }) : ok());

    try {
      await provisionAllHumans([good, "-refused"]);
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }

    expect(logs.join("\n")).toContain("could not register 2 person(s)");
    expect(logs.join("\n")).toContain("-refused (");
    expect(logs.join("\n")).not.toContain("registered 1 person");
  });

  test("counts the ones that worked", async () => {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    hub(() => ok());

    try {
      await provisionAllHumans([uniq("A"), uniq("B")]);
    } finally {
      console.log = realLog;
    }

    expect(logs.join("\n")).toContain("registered 2 person(s)");
  });
});
