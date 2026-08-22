import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { TenantManagementPage } = await import("./TenantManagementPage.tsx");

const DIRECTORY = "/api/v1/admin/tenants/directory";
const TENANTS = "/api/v1/admin/tenants";
const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const LANG_KEY = "agent_mesh_lang";
const en = (key: string) => DICTIONARY.en[key]!;

interface Row {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

const DEFAULT_ROW: Row = { id: "default", name: "\uD50C\uB7AB\uD3FC", created_at: "2026-08-22T00:00:00Z", deleted_at: null };
const ACME_ROW: Row = { id: "acme", name: "Acme", created_at: "2026-08-22T01:00:00Z", deleted_at: null };
const DELETED_ROW: Row = {
  id: "old",
  name: "Old tenant",
  created_at: "2026-08-20T01:00:00Z",
  deleted_at: "2026-08-22T02:00:00Z",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let rows: Row[];
let directoryAnswer: (() => Response | Promise<Response>) | null;
let writeAnswer: (() => Response | Promise<Response>) | null;
const calls: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  localStorage.removeItem(LANG_KEY);
  calls.length = 0;
  rows = [{ ...DEFAULT_ROW }, { ...ACME_ROW }, { ...DELETED_ROW }];
  directoryAnswer = null;
  writeAnswer = null;
  window.confirm = () => true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });

    if (url.endsWith(DIRECTORY) && method === "GET") {
      if (directoryAnswer) return await directoryAnswer();
      return json(200, { ok: true, tenant: "default", tenants: rows });
    }
    if (method !== "GET" && writeAnswer) return await writeAnswer();
    if (url.endsWith(TENANTS) && method === "POST") {
      const parsed = JSON.parse(body ?? "null");
      const tenant: Row = { id: parsed.id, name: parsed.name, created_at: "2026-08-22T03:00:00Z", deleted_at: null };
      rows = [...rows, tenant];
      return json(201, { ok: true, tenant });
    }
    const match = /\/api\/v1\/admin\/tenants\/([^/?]+)$/.exec(url);
    if (match && method === "PATCH") {
      const id = decodeURIComponent(match[1]!);
      const parsed = JSON.parse(body ?? "null");
      rows = rows.map((row) => row.id === id ? { ...row, name: parsed.name } : row);
      return json(200, { ok: true, tenant: rows.find((row) => row.id === id) ?? null });
    }
    if (match && method === "DELETE") {
      const id = decodeURIComponent(match[1]!);
      const deletedAt = "2026-08-22T04:00:00Z";
      rows = rows.map((row) => row.id === id ? { ...row, deleted_at: deletedAt } : row);
      return json(200, { ok: true, action: "deleted", tenant: rows.find((row) => row.id === id) ?? null });
    }
    throw new TypeError(`unexpected request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(LANG_KEY);
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
});

const settle = async () => {
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/platform/tenant-directory"]}>
        <TenantManagementPage />
      </MemoryRouter>
    </I18nProvider>,
  );
  await settle();
};

const input = (testId: string, value: string) => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

const writes = (method: string) => calls.filter((call) => call.method === method);

describe("tenant management", () => {
  it("keeps the seeded tenant renameable while locking delete in the muted grammar", async () => {
    await mount();
    expect(screen.getByTestId("tenant-name-default").textContent).toBe(DEFAULT_ROW.name);

    const rename = screen.getByTestId("tenant-rename-default") as HTMLButtonElement;
    const remove = screen.getByTestId("tenant-delete-default") as HTMLButtonElement;
    expect(rename.disabled).toBe(false);
    expect(remove.disabled).toBe(true);
    expect(remove.dataset.fixedDefault).toBe("true");
    expect(remove.style.opacity).toBe("0.45");
    expect(screen.getByTestId("tenant-delete-reason-default").textContent)
      .toBe(en("tenantDirectory.defaultDeleteReason"));

    // The handler guards the contract as well as the DOM. Manually clearing
    // `disabled` must not manufacture a DELETE request.
    remove.disabled = false;
    fireEvent.click(remove);
    await settle();
    expect(writes("DELETE")).toHaveLength(0);
  });

  it("renames the default tenant without changing its stable id", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("tenant-rename-default"));
    input("tenant-rename-input-default", "Platform home");
    fireEvent.click(screen.getByTestId("tenant-rename-save-default"));
    await settle();

    expect(writes("PATCH")).toHaveLength(1);
    expect(writes("PATCH")[0]!.url).toMatch(/\/tenants\/default$/);
    expect(JSON.parse(writes("PATCH")[0]!.body ?? "null")).toEqual({ name: "Platform home" });
    expect(screen.getByTestId("tenant-name-default").textContent).toBe("Platform home");
    expect(screen.getByTestId("tenant-id-default").textContent).toBe("default");
  });

  it("cancels a rename without changing the row or sending a write", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("tenant-rename-acme"));
    input("tenant-rename-input-acme", "A name not saved");
    fireEvent.click(screen.getByTestId("tenant-rename-cancel-acme"));

    expect(screen.queryByTestId("tenant-rename-input-acme")).toBeNull();
    expect(screen.getByTestId("tenant-name-acme").textContent).toBe(ACME_ROW.name);
    expect(writes("PATCH")).toHaveLength(0);
  });

  it("creates a tenant and re-reads it into the directory", async () => {
    await mount();
    input("tenant-create-id", "tenant-b");
    input("tenant-create-name", "Tenant B");
    fireEvent.submit(screen.getByTestId("tenant-create-form"));
    await settle();

    expect(writes("POST")).toHaveLength(1);
    expect(JSON.parse(writes("POST")[0]!.body ?? "null")).toEqual({ id: "tenant-b", name: "Tenant B" });
    expect(screen.getByTestId("tenant-name-tenant-b").textContent).toBe("Tenant B");
    expect(calls.filter((call) => call.method === "GET" && call.url.endsWith(DIRECTORY))).toHaveLength(2);
  });

  it("calls an unanswered create unknown instead of reporting success", async () => {
    writeAnswer = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    input("tenant-create-id", "tenant-b");
    input("tenant-create-name", "Tenant B");
    fireEvent.submit(screen.getByTestId("tenant-create-form"));
    await settle();

    expect(writes("POST")).toHaveLength(1);
    expect(screen.getByTestId("tenant-mutation-error").textContent)
      .toBe(en("tenantDirectory.writeUnreachable"));
    expect(screen.queryByTestId("tenant-mutation-notice")).toBeNull();
    expect((screen.getByTestId("tenant-create-id") as HTMLInputElement).value).toBe("tenant-b");
  });

  it("keeps failed rename and delete writes on screen as failures", async () => {
    writeAnswer = () => { throw new TypeError("Failed to fetch"); };
    await mount();

    fireEvent.click(screen.getByTestId("tenant-rename-default"));
    input("tenant-rename-input-default", "Not renamed");
    fireEvent.click(screen.getByTestId("tenant-rename-save-default"));
    await settle();
    expect(writes("PATCH")).toHaveLength(1);
    expect(screen.getByTestId("tenant-mutation-error").textContent)
      .toBe(en("tenantDirectory.writeUnreachable"));
    expect(screen.getByTestId("tenant-rename-input-default")).not.toBeNull();

    fireEvent.click(screen.getByTestId("tenant-delete-acme"));
    await settle();
    expect(writes("DELETE")).toHaveLength(1);
    expect(screen.getByTestId("tenant-mutation-error").textContent)
      .toBe(en("tenantDirectory.writeUnreachable"));
    expect(screen.getByTestId("tenant-status-acme").dataset.deleted).toBe("false");
    expect(screen.queryByTestId("tenant-mutation-notice")).toBeNull();
  });

  it("soft-deletes without making the row disappear", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("tenant-delete-acme"));
    await settle();

    expect(writes("DELETE")).toHaveLength(1);
    expect(screen.getByTestId("tenant-name-acme").textContent).toBe("Acme");
    expect(screen.getByTestId("tenant-status-acme").dataset.deleted).toBe("true");
    expect(screen.getByTestId("tenant-status-acme").textContent).toContain(en("tenantDirectory.status.deleted"));
    expect((screen.getByTestId("tenant-delete-acme") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("tenant-mutation-notice").textContent).toBe(en("tenantDirectory.deleted"));
  });

  it("shows a row the server says was already deleted", async () => {
    await mount();
    expect(screen.getByTestId("tenant-name-old").textContent).toBe(DELETED_ROW.name);
    expect(screen.getByTestId("tenant-status-old").textContent).toContain(DELETED_ROW.deleted_at!);
    expect(screen.getByTestId("tenant-status-old").dataset.deleted).toBe("true");
    expect((screen.getByTestId("tenant-delete-old") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not call an unanswered directory an empty one", async () => {
    directoryAnswer = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    const page = screen.getByTestId("tenant-management").textContent ?? "";
    expect(page).toContain(en("tenantDirectory.error"));
    expect(page).not.toContain(en("tenantDirectory.empty"));
  });

  it("does not call a malformed directory response an empty directory", async () => {
    directoryAnswer = () => json(200, { ok: true, tenant: "default" });
    await mount();
    const page = screen.getByTestId("tenant-management").textContent ?? "";
    expect(page).toContain(en("tenantDirectory.error"));
    expect(page).not.toContain(en("tenantDirectory.empty"));
  });

  it("tells a refusal from an unanswered directory", async () => {
    directoryAnswer = () => json(403, { ok: false, error: "platform admin only" });
    await mount();
    const page = screen.getByTestId("tenant-management").textContent ?? "";
    expect(page).toContain(en("common.refusedRead"));
    expect(page).not.toContain(en("tenantDirectory.error"));
  });
});
