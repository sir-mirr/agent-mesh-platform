import React, { useState, useEffect } from "react";
import { PageHeader, Breadcrumbs, DataTable, Button } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchLocalUsers, admitLocalUserApi, type LocalUser } from "@/api/users.ts";
import { ApiError } from "@/api/client.ts";

/**
 * Admitting a person, from a screen rather than from `curl`.
 *
 * Two things here are the scenario document's, not decoration:
 *
 * - The temporary password lives in component state and nowhere else. Not
 *   `localStorage`, not the URL, not the list: a reload loses it, which is what
 *   "once" has to mean for the word to be true. `SC-USER-D1` reloads.
 * - A refusal shows the server's sentence. The duplicate-name case has a real
 *   message (`a local account named 'x' already exists`) and inventing a
 *   friendlier one here would make the screen the author of a fact it does not
 *   hold. `SC-USER-D2` reads it.
 */
export function UserAdminPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await fetchLocalUsers();
      setUsers(res.users ?? []);
      setIsError(false);
    } catch {
      setUsers([]);
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || busy) return;
    setBusy(true);
    setRefusal(null);
    setIssued(null);
    try {
      const res = await admitLocalUserApi(username.trim(), displayName.trim());
      setIssued({ username: res.user?.username ?? username.trim(), password: res.temporary_password });
      setUsername("");
      setDisplayName("");
      await load();
    } catch (err: any) {
      // The server's words. `ApiError` separates refused from unreachable, and
      // those are different sentences for the person reading them.
      setRefusal(
        err instanceof ApiError && err.status === null
          ? t("users.unreachable", "The server did not answer. Nothing was created.")
          : String(err?.message ?? err),
      );
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: "username",
      header: t("users.col.username", "Username"),
      render: (u: LocalUser) => (
        <span data-testid={`user-row-${u.username}`} style={{ fontWeight: 700 }}>
          {u.username}
        </span>
      ),
    },
    {
      key: "display_name",
      header: t("users.col.display", "Name"),
      render: (u: LocalUser) => <span>{u.display_name || "—"}</span>,
    },
    {
      key: "role",
      header: t("users.col.role", "Role"),
      render: (u: LocalUser) => <span data-testid={`user-role-${u.username}`}>{u.role ?? "—"}</span>,
    },
    {
      key: "tenant",
      header: t("users.col.tenant", "Tenant"),
      render: (u: LocalUser) => <span>{u.tenant ?? "—"}</span>,
    },
    {
      key: "state",
      header: t("users.col.state", "Password"),
      render: (u: LocalUser) => (
        <span data-testid={`user-state-${u.username}`}>
          {u.must_change_password
            ? t("users.state.temp", "temporary — must be changed at first sign-in")
            : t("users.state.chosen", "chosen")}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} data-testid="user-admin">
      <Breadcrumbs />
      <PageHeader
        suiteTag="PLATFORM ADMIN"
        suiteBadgeColor="leased"
        screenId="37"
        title={t("users.title", "Local accounts")}
        subtitle={t(
          "users.subtitle",
          "Admit a person and hand them one temporary password. They choose their own before they can do anything else.",
        )}
      />

      <form
        onSubmit={submit}
        data-testid="admit-form"
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          padding: 16,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.username", "Username")}
          <input
            data-testid="admit-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("users.field.username.ph", "letters, digits and dashes")}
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              color: "var(--color-text-primary)",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.display", "Name")}
          <input
            data-testid="admit-display"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              color: "var(--color-text-primary)",
            }}
          />
        </label>
        <Button type="submit" data-testid="admit-submit" disabled={busy}>
          {busy ? t("users.admitting", "Admitting…") : t("users.admit", "Admit")}
        </Button>
      </form>

      {refusal && (
        <div
          data-testid="admit-error"
          style={{
            padding: 12,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontSize: "0.85rem",
          }}
        >
          {refusal}
        </div>
      )}

      {issued && (
        <div
          data-testid="issued-password"
          style={{
            padding: 14,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-primary)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <strong>
            {t("users.issued.for", "Temporary password for")} {issued.username}
          </strong>
          <code data-testid="issued-value" style={{ fontSize: "1rem", letterSpacing: "0.02em" }}>
            {issued.password}
          </code>
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            {t(
              "users.issued.once",
              "Shown once. Leaving or reloading this page loses it, and the server will not repeat it — admit the person again to issue a new one.",
            )}
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={users}
        keyExtractor={(u: LocalUser) => u.username}
        isLoading={isLoading}
        isError={isError}
        errorMessage={t("users.error", "Could not read the accounts list (user.admit required, or the server refused).")}
        emptyMessage={t("users.empty", "No local accounts yet.")}
      />
    </div>
  );
}
