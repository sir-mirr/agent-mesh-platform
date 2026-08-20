import React, { useState, useEffect } from "react";
import { PageHeader, Breadcrumbs, DataTable, Button } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchLocalUsers, admitLocalUserApi, fetchPendingAdmissions, type LocalUser, type PendingAdmission } from "@/api/users.ts";
import { ApiError, failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";

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
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * The other decision queue. Four states, not two: a list, an empty list, a
   * refusal, and a read that did not happen. `[]` and *could not ask* are the
   * pair this screen must never fold together — the empty one is a claim that
   * nobody is waiting, and this front end asked for this queue nowhere at all
   * until now, which is the same claim made silently.
   */
  const [queue, setQueue] = useState<PendingAdmission[] | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueFailure, setQueueFailure] = useState<FailureKind | null>(null);
  const [queueMissing, setQueueMissing] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await fetchLocalUsers();
      setUsers(res.users ?? []);
      setIsError(false);
      setFailure(null);
    } catch (err: unknown) {
      setUsers([]);
      setIsError(true);
      setFailure(failureKind(err));
        setMissing(refusedCapability(err));
    } finally {
      setIsLoading(false);
    }
  };

  const loadQueue = async () => {
    setQueueLoading(true);
    try {
      setQueue(await fetchPendingAdmissions());
      setQueueFailure(null);
      setQueueMissing(null);
    } catch (err: unknown) {
      // Not `[]`. A queue that could not be read is not a queue with nobody in it.
      setQueue(null);
      setQueueFailure(failureKind(err));
      setQueueMissing(refusedCapability(err));
    } finally {
      setQueueLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadQueue();
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
              // The sentence used to end `— admit the person again to issue a
              // new one`, and admitting an existing account answers `409` at
              // `main.ts:2462`. The screen was instructing an operator to do
              // the one thing the server refuses. It says what is true and
              // stops; the re-issue route is somebody else's commit.
              "Shown once. Leaving or reloading this page loses it, and the server will not repeat it.",
            )}
          </span>
        </div>
      )}

      <section
        data-testid="admission-queue"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 16,
          border: "1px solid var(--color-border)",
          borderRadius: 8,
        }}
      >
        <strong>{t("users.queue.title", "People who asked to be let in")}</strong>
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          {t("users.queue.hint", "A different queue from the key requests. The bell does not show anyone here.")}
        </span>

        {queueLoading ? (
          <span data-testid="admission-queue-loading">{t("users.queue.loading", "Reading the queue…")}</span>
        ) : queueFailure === "refused" ? (
          <span data-testid="admission-queue-refused">{refusedText(t, queueMissing)}</span>
        ) : queue === null ? (
          <span data-testid="admission-queue-unreachable">
            {t("users.queue.unreachable", "The queue could not be read — which is not the same as empty.")}
          </span>
        ) : queue.length === 0 ? (
          <span data-testid="admission-queue-empty">{t("users.queue.empty", "Nobody is waiting.")}</span>
        ) : (
          <ul data-testid="admission-queue-list" style={{ margin: 0, paddingLeft: 18 }}>
            {queue.map((p) => (
              <li key={p.github_login} data-testid={`admission-row-${p.github_login}`}>
                {p.github_login}
                {p.requested_at ? <span style={{ color: "var(--color-text-muted)" }}> · {p.requested_at}</span> : null}
              </li>
            ))}
          </ul>
        )}

        {/* Read-only here on purpose: this commit closes the blindness, not the
            acting. The routes that decide (`admin/approve`, `admin/deny`) are
            already driven by the server-rendered admin page, and putting a
            second actor on them is its own change. */}
        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
          {t("users.queue.decide", "Decisions are made on the server-rendered admin page.")}
        </span>
      </section>

      <DataTable
        columns={columns}
        data={users}
        keyExtractor={(u: LocalUser) => u.username}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("users.error", "계정 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("users.empty", "No local accounts yet.")}
      />
    </div>
  );
}
