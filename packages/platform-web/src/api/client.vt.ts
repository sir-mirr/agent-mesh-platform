/**
 * The two words a screen has to tell apart: *refused* and *unreachable*.
 *
 * This distinction has cost this console twice. A `502` from a proxy was read
 * as a signed-out session and threw operators to a login form that could not
 * log them in; and nine screens drew "the server did not answer" at people the
 * server had answered, with `403`. Both are decided here, in four functions
 * that no browser is needed to run — and until this file they were only ever
 * executed inside a Playwright page, where no coverage instrument could see
 * them and no assertion named them directly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, apiClient, failureKind, refusedCapability, refusedText } from "./client.ts";

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); });

describe("ApiError", () => {
  it("separates a refusal from never having been answered", () => {
    expect(new ApiError("no", 403, null).refused).toBe(true);
    expect(new ApiError("no", 401, null).refused).toBe(true);
    // A 5xx is the server failing, not the server refusing. This is the exact
    // line the 502-as-logout defect crossed.
    expect(new ApiError("boom", 502, null).refused).toBe(false);
    expect(new ApiError("offline", null, null).refused).toBe(false);
  });

  it("carries the capability the server named", () => {
    expect(new ApiError("no", 403, "key.approve").capability).toBe("key.approve");
    expect(refusedCapability(new ApiError("no", 403, "group.manage"))).toBe("group.manage");
    // Anything that is not an ApiError has not named one, and guessing here is
    // what the six hand-typed copies were.
    expect(refusedCapability(new Error("plain"))).toBe(null);
  });
});

describe("failureKind", () => {
  it("calls a 4xx refused and everything else unreachable", () => {
    expect(failureKind(new ApiError("no", 403, null))).toBe("refused");
    expect(failureKind(new ApiError("boom", 500, null))).toBe("unreachable");
    expect(failureKind(new ApiError("offline", null, null))).toBe("unreachable");
    expect(failureKind(new Error("plain"))).toBe("unreachable");
  });
});

describe("refusedText", () => {
  const t = (_key: string, fallback: string) => fallback;
  it("repeats the server's word for what is missing", () => {
    expect(refusedText(t, "key.approve")).toContain("(key.approve)");
  });
  it("says only that it is not allowed when the server named nothing", () => {
    expect(refusedText(t, null)).not.toContain("(");
  });
});

describe("apiClient", () => {
  it("reads a refusal's fields rather than its sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      answer(403, { error: "not allowed", capability: "mailbox.read.depth" })));
    const err = await apiClient("/api/v1/whatever").then(() => null, (e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.status).toBe(403);
    expect(err!.capability).toBe("mailbox.read.depth");
    expect(err!.message).toBe("not allowed");
  });

  it("reports no answer as status null, which is not zero and not a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await apiClient("/api/v1/whatever").then(() => null, (e) => e as ApiError);
    expect(err!.status).toBe(null);
    expect(err!.refused).toBe(false);
    expect(failureKind(err)).toBe("unreachable");
  });

  it("falls back to the status line when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" })));
    const err = await apiClient("/api/v1/whatever").then(() => null, (e) => e as ApiError);
    expect(err!.status).toBe(502);
    expect(err!.message).toContain("Bad Gateway");
  });

  it("sends the cookie, asks for JSON, and types a string body", async () => {
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      answer(200, { ok: true }));
    vi.stubGlobal("fetch", spy);
    await apiClient("/api/v1/thing", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const init = spy.mock.calls[0]![1]!;
    expect(init.credentials).toBe("include");
    const headers = init.headers as Headers;
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("leaves an absolute URL alone and prefixes a relative one", async () => {
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      answer(200, { ok: true }));
    vi.stubGlobal("fetch", spy);
    await apiClient("https://elsewhere.example/api/v1/thing");
    expect(spy.mock.calls[0]![0]).toBe("https://elsewhere.example/api/v1/thing");
    await apiClient("/api/v1/thing");
    expect(String(spy.mock.calls[1]![0])).toMatch(/\/api\/v1\/thing$/);
  });
});
