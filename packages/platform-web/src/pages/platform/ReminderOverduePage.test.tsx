import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerDom } from "../../register-dom";

registerDom();

const { act, cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { CAPABILITY, HTTP_ADMIN_ERROR } = await import("@agent-mesh/contracts");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { ReminderOverduePage, formatOverdue } = await import("./ReminderOverduePage.tsx");

const ME = "/auth/me";
const KEY_QUEUE = "/api/v1/admin/keys/pending";
const OVERDUE = "/api/v1/admin/reminders/overdue";
const USER_KEY = "agent_mesh_user";
const LANG_KEY = "agent_mesh_lang";
const realFetch = globalThis.fetch;
const beforeUser = localStorage.getItem(USER_KEY);
const beforeLanguage = localStorage.getItem(LANG_KEY);

const en = (key: string) => DICTIONARY.en[key]!;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type RouteAnswer = (method: string, init?: RequestInit) => Response | Promise<Response>;
let capabilities: string[];
let overdueAnswer: RouteAnswer;
const calls: Array<{ url: string; method: string; body: unknown }> = [];

const held = {
  reminder_id: "once:billing/7",
  agent_id: "agent-7",
  scheduled_at: "2026-08-29T01:02:03.000Z",
  held_since: "2026-08-29T02:03:04.000Z",
  overdue_ms: 90_061_000,
  status: "active",
};

const recorded = {
  reminder_id: "once-closed",
  scheduled_at: "2026-08-28T08:00:00.000Z",
  decision: "skip",
  approval_ref: "APPROVED: incident-71",
  decided_at: "2026-08-28T08:10:00.000Z",
  decided_by: "operator-kim",
};

const state = (reminders: unknown[] = [held], decisions: unknown[] = [recorded]) => ({
  ok: true,
  reminders,
  decisions,
});

const restoreStorage = () => {
  if (beforeUser === null) localStorage.removeItem(USER_KEY);
  else localStorage.setItem(USER_KEY, beforeUser);
  if (beforeLanguage === null) localStorage.removeItem(LANG_KEY);
  else localStorage.setItem(LANG_KEY, beforeLanguage);
};

beforeEach(() => {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(LANG_KEY);
  capabilities = [CAPABILITY.REMINDER_READ_HELD, CAPABILITY.REMINDER_DECIDE];
  calls.length = 0;
  overdueAnswer = () => json(200, state());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url, "http://console.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });

    if (path === ME) {
      return json(200, {
        github_id: 7,
        github_login: "operator-1",
        role: "member",
        approved: true,
        tenant: "tenant_default",
        capabilities,
        created_at: "2026-01-01T00:00:00Z",
      });
    }
    if (path === KEY_QUEUE) return json(200, { ok: true, keys: [] });
    if (path === OVERDUE || path.startsWith(`${OVERDUE}/`)) {
      return await overdueAnswer(method, init);
    }
    throw new TypeError(`No route for ${path}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  restoreStorage();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  restoreStorage();
  globalThis.fetch = realFetch;
});

const settle = async () => {
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  render(
    <I18nProvider>
      <AuthProvider>
        <RbacProvider>
          <MemoryRouter initialEntries={["/platform/reminders/overdue"]}>
            <ReminderOverduePage />
          </MemoryRouter>
        </RbacProvider>
      </AuthProvider>
    </I18nProvider>,
  );
  await settle();
};

const heldSection = () => screen.getByTestId("overdue-held-list");
const historySection = () => screen.getByTestId("overdue-decision-history");
const heldRow = () => heldSection().querySelector("tbody tr") as HTMLElement;
const postCalls = () => calls.filter((call) => call.method === "POST");

describe("overdue reminder read states", () => {
  it("draws each held slot, how late it is, and recorded decisions on one screen", async () => {
    await mount();

    const waiting = heldSection().textContent ?? "";
    expect(waiting).toContain(held.reminder_id);
    expect(waiting).toContain(held.agent_id);
    expect(waiting).toContain(held.scheduled_at);
    expect(waiting).toContain(held.held_since);
    expect(screen.getByTestId("overdue-duration").textContent).toBe("1d 1h 1m");

    const history = historySection().textContent ?? "";
    expect(history).toContain(recorded.reminder_id);
    expect(history).toContain(recorded.scheduled_at);
    expect(screen.getByTestId("overdue-recorded-decision").getAttribute("data-decision")).toBe("skip");
    expect(screen.getByTestId("overdue-recorded-approval").textContent).toBe(recorded.approval_ref);
    expect(screen.getByTestId("overdue-recorded-decider").textContent).toBe(recorded.decided_by);
  });

  it("calls a missing read capability a refusal, not an empty queue or an outage", async () => {
    capabilities = [];
    overdueAnswer = () => json(403, {
      error: "not allowed",
      capability: CAPABILITY.REMINDER_READ_HELD,
    });
    await mount();

    expect(screen.queryByTestId("overdue-refused")).not.toBe(null);
    expect(screen.queryByTestId("overdue-unreachable")).toBe(null);
    expect(screen.queryByTestId("overdue-held-list")).toBe(null);
    expect(document.body.textContent).toContain(`${en("common.refusedRead")}.`);
    expect(document.body.textContent).not.toContain(CAPABILITY.REMINDER_READ_HELD);
  });

  it("calls no server answer unreachable rather than refused", async () => {
    overdueAnswer = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    expect(screen.queryByTestId("overdue-unreachable")).not.toBe(null);
    expect(screen.queryByTestId("overdue-refused")).toBe(null);
    expect(document.body.textContent).toContain(en("overdue.readFailed"));
  });

  it("keeps an answered empty queue and empty history as two explicit answers", async () => {
    overdueAnswer = () => json(200, state([], []));
    await mount();
    expect(heldSection().textContent).toContain(en("overdue.held.empty"));
    expect(historySection().textContent).toContain(en("overdue.history.empty"));
  });
});

describe("the separate decision capability", () => {
  it("removes every decision control when the account may read but may not decide", async () => {
    capabilities = [CAPABILITY.REMINDER_READ_HELD];
    await mount();

    expect(screen.queryByTestId("overdue-decision-controls")).toBe(null);
    expect(screen.queryByRole("textbox")).toBe(null);
    expect(screen.queryByRole("button", { name: en("overdue.replay") })).toBe(null);
    expect(screen.queryByRole("button", { name: en("overdue.skip") })).toBe(null);
    expect(screen.getByTestId("overdue-decision-unavailable").textContent)
      .toBe(en("overdue.decision.unavailable"));
  });

  it("uses the server's 403 as the final authority and removes stale controls", async () => {
    overdueAnswer = (method) => method === "GET"
      ? json(200, state())
      : json(403, { error: "not allowed", capability: CAPABILITY.REMINDER_DECIDE });
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "APPROVED: incident-72" } });
    fireEvent.click(within(heldRow()).getByRole("button", { name: en("overdue.replay") }));
    await settle();

    expect(screen.getByTestId("overdue-action-error").textContent)
      .toContain(en("overdue.decision.refused"));
    expect(screen.queryByTestId("overdue-decision-controls")).toBe(null);
    expect(screen.getByTestId("overdue-decision-unavailable")).not.toBe(null);
  });
});

describe("recording a decision for the slot the operator saw", () => {
  it("blocks a blank, bare-prefix, or unprefixed approval before any POST", async () => {
    await mount();
    const input = screen.getByRole("textbox");
    const replay = within(heldRow()).getByRole("button", { name: en("overdue.replay") });
    for (const value of ["", "APPROVED:   ", "incident-72"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(replay);
      await settle();
      expect({
        value,
        userError: screen.queryByTestId("overdue-action-error")?.textContent
          ?.includes(en("overdue.approval.required")) ?? false,
        posts: postCalls().length,
      }).toEqual({ value, userError: true, posts: 0 });
    }
  });

  it("posts replay with the exact listed scheduled_at and then draws the persisted record", async () => {
    let decided = false;
    overdueAnswer = (method, init) => {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          scheduled_at: held.scheduled_at,
          decision: "replay",
          approval_ref: "APPROVED: incident-72",
        });
        decided = true;
        return json(200, { ok: true, ...body, reminder_id: held.reminder_id, decided_by: "operator-1", decided_at: "2026-08-29T03:00:00Z" });
      }
      return json(200, decided
        ? state([], [{
            reminder_id: held.reminder_id,
            scheduled_at: held.scheduled_at,
            decision: "replay",
            approval_ref: "APPROVED: incident-72",
            decided_at: "2026-08-29T03:00:00Z",
            decided_by: "operator-1",
          }])
        : state());
    };
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "APPROVED: incident-72" } });
    fireEvent.click(within(heldRow()).getByRole("button", { name: en("overdue.replay") }));
    await settle();

    expect(postCalls()).toHaveLength(1);
    expect(new URL(postCalls()[0]!.url, "http://console.test").pathname).toBe(
      "/api/v1/admin/reminders/overdue/once%3Abilling%2F7/decision",
    );
    expect(screen.getByTestId("overdue-recorded-decision").getAttribute("data-decision")).toBe("replay");
    expect(screen.getByTestId("overdue-recorded-approval").textContent).toBe("APPROVED: incident-72");
    expect(screen.getByTestId("overdue-recorded-decider").textContent).toBe("operator-1");
  });

  it("posts skip as skip instead of folding it into replay", async () => {
    overdueAnswer = (method, init) => method === "POST"
      ? json(200, { ok: true, ...JSON.parse(String(init?.body)) })
      : json(200, state());
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "APPROVED:x" } });
    fireEvent.click(within(heldRow()).getByRole("button", { name: en("overdue.skip") }));
    await settle();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]?.body).toEqual({
      scheduled_at: held.scheduled_at,
      decision: "skip",
      approval_ref: "APPROVED:x",
    });
  });

  it("draws EMPTY_APPROVAL_REF as a user error rather than a network failure", async () => {
    overdueAnswer = (method) => method === "POST"
      ? json(400, { error: "no reason", code: HTTP_ADMIN_ERROR.EMPTY_APPROVAL_REF })
      : json(200, state());
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "APPROVED: incident-72" } });
    fireEvent.click(within(heldRow()).getByRole("button", { name: en("overdue.replay") }));
    await settle();
    expect(screen.getByTestId("overdue-action-error").textContent)
      .toContain(en("overdue.approval.serverRefused"));
    expect(screen.queryByTestId("overdue-unreachable")).toBe(null);
  });

  it("sends only one request when the same decision is clicked twice while pending", async () => {
    let finish: ((response: Response) => void) | undefined;
    overdueAnswer = (method) => method === "POST"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : json(200, state());
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "APPROVED: incident-72" } });
    const replay = within(heldRow()).getByRole("button", { name: en("overdue.replay") });
    fireEvent.click(replay);
    fireEvent.click(replay);
    expect(postCalls()).toHaveLength(1);
    await act(async () => {
      finish?.(json(200, { ok: true }));
      await new Promise((done) => setTimeout(done, 0));
    });
  });
});

describe("overdue duration", () => {
  it("keeps measured days, hours, and minutes distinct from an unmeasured value", () => {
    expect(formatOverdue(90_061_000, "en")).toBe("1d 1h 1m");
    expect(formatOverdue(90_061_000, "ko")).toBe("1일 1시간 1분");
    expect(formatOverdue(null, "en")).toBe(en("overdue.duration.unmeasured"));
  });
});
