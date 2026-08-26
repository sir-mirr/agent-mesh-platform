import React, { useState, useEffect, useRef } from "react";
import { PageHeader, Breadcrumbs, DataTable, Button } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import {
  fetchLocalUsers,
  admitLocalUserApi,
  fetchPendingAdmissions,
  decidePendingAdmissionApi,
  reissueLocalUserPasswordApi,
  type AdmissionDecision,
  type LocalUser,
  type PendingAdmission,
} from "@/api/users.ts";
import { fetchTenantDirectory, type TenantDirectoryItem } from "@/api/tenants.ts";
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
  const [issued, setIssued] = useState<{ username: string; password: string; action: "created" | "reissued" } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reissueRefusal, setReissueRefusal] = useState<string | null>(null);
  const [confirmingReissue, setConfirmingReissue] = useState<string | null>(null);
  const [reissuing, setReissuing] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantDirectoryItem[] | null>(null);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [tenantLoading, setTenantLoading] = useState(true);
  const [tenantFailure, setTenantFailure] = useState<FailureKind | null>(null);
  const [tenantMissing, setTenantMissing] = useState<string | null>(null);
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
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [confirmingDecision, setConfirmingDecision] = useState<{
    login: string;
    decision: AdmissionDecision;
  } | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<{
    login: string;
    decision: AdmissionDecision;
  } | null>(null);
  const decisionInFlight = useRef(false);

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

  const loadTenants = async () => {
    setTenantLoading(true);
    try {
      const response = await fetchTenantDirectory();
      if (!Array.isArray(response.tenants)) {
        throw new Error("tenant directory response did not include tenants");
      }
      // Deleted tenants remain in the management directory for history, but
      // are not offered for new accounts. The server enforces the same rule.
      const available = response.tenants.filter((tenant) => tenant.deleted_at === null);
      setTenants(available);
      setSelectedTenant((current) => {
        if (available.some((tenant) => tenant.id === current)) return current;
        return available.find((tenant) => tenant.id === response.tenant)?.id ?? available[0]?.id ?? "";
      });
      setTenantFailure(null);
      setTenantMissing(null);
    } catch (err: unknown) {
      // Do not silently admit into a guessed tenant when the picker could not
      // be populated. The server has a default, but the operator was promised
      // a visible choice and a failed read is not that choice.
      setTenants(null);
      setSelectedTenant("");
      setTenantFailure(failureKind(err));
      setTenantMissing(refusedCapability(err));
    } finally {
      setTenantLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadQueue();
    void loadTenants();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !selectedTenant || tenantLoading || tenants === null || busy) return;
    setBusy(true);
    setRefusal(null);
    setReissueRefusal(null);
    setConfirmingReissue(null);
    setIssued(null);
    try {
      const res = await admitLocalUserApi(
        username.trim(),
        displayName.trim(),
        selectedTenant,
        "member",
      );
      setIssued({
        username: res.user?.username ?? username.trim(),
        password: res.temporary_password,
        action: "created",
      });
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

  const reissuePassword = async (user: LocalUser) => {
    if (reissuing !== null) return;
    setReissuing(user.username);
    setReissueRefusal(null);
    setRefusal(null);
    setIssued(null);
    try {
      const response = await reissueLocalUserPasswordApi(user.username);
      setIssued({
        username: response.username,
        password: response.temporary_password,
        action: "reissued",
      });
      setConfirmingReissue(null);
      await load();
    } catch (err: any) {
      setReissueRefusal(
        err instanceof ApiError && err.status === null
          ? t("users.reissue.unreachable", "The server did not answer. The password was not reissued.")
          : String(err?.message ?? err),
      );
    } finally {
      setReissuing(null);
    }
  };

  const decideAdmission = async (login: string, decision: AdmissionDecision) => {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    setDeciding(login);
    setDecisionError(null);
    setDecisionNotice(null);
    try {
      await decidePendingAdmissionApi(login, decision);
      setDecisionNotice({ login, decision });
      setConfirmingDecision(null);
      await loadQueue();
    } catch (err: any) {
      setDecisionError(
        err instanceof ApiError && err.status === null
          ? t("users.queue.decisionUnreachable", "The server did not answer. No decision was saved.")
          : String(err?.message ?? err),
      );
      setConfirmingDecision(null);
    } finally {
      decisionInFlight.current = false;
      setDeciding(null);
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
      render: (u: LocalUser) => {
        const isAdmin = u.role === "admin";
        return (
          <span
            data-testid={`user-role-${u.username}`}
            data-privilege={isAdmin ? "high" : "standard"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "3px 8px",
              borderRadius: 999,
              border: `1px solid ${isAdmin ? "var(--color-warning)" : "var(--color-border)"}`,
              background: isAdmin ? "rgba(217, 119, 6, 0.1)" : "var(--color-bg-surface-sub)",
              color: isAdmin ? "var(--color-warning)" : "var(--color-text-secondary)",
              fontSize: "0.75rem",
              fontWeight: 700,
            }}
          >
            {isAdmin
              ? t("users.role.admin", "Platform administrator")
              : t("users.role.member", "Standard account")}
          </span>
        );
      },
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
    {
      key: "password_action",
      header: t("users.col.passwordAction", "Password action"),
      render: (u: LocalUser) => confirmingReissue === u.username ? (
        <div
          data-testid={`reissue-confirm-${u.username}`}
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, minWidth: 210 }}
        >
          <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
            {u.role === "admin"
              ? t("users.reissue.confirmAdmin", "This is a platform administrator. Reissue its temporary password?")
              : t("users.reissue.confirm", "Reissue this account's temporary password?")}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              type="button"
              size="sm"
              variant={u.role === "admin" ? "danger" : "primary"}
              data-testid={`reissue-confirm-submit-${u.username}`}
              disabled={reissuing !== null}
              onClick={() => void reissuePassword(u)}
            >
              {reissuing === u.username
                ? t("users.reissuing", "Reissuing…")
                : t("users.reissue.confirmAction", "Confirm reissue")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid={`reissue-cancel-${u.username}`}
              disabled={reissuing !== null}
              onClick={() => setConfirmingReissue(null)}
            >
              {t("common.cancel", "Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={u.role === "admin" ? "outline" : "secondary"}
          data-testid={`reissue-${u.username}`}
          disabled={reissuing !== null}
          onClick={() => setConfirmingReissue(u.username)}
        >
          {t("users.reissue", "Reissue temporary password")}
        </Button>
      ),
    },
  ];

  const renderQueue = (withDecisions: boolean) => {
    if (queueLoading) {
      return <span data-testid="admission-queue-loading">{t("users.queue.loading", "Reading the queue…")}</span>;
    }
    if (queueFailure === "refused") {
      return <span data-testid="admission-queue-refused">{refusedText(t, queueMissing)}</span>;
    }
    if (queue === null) {
      return (
        <span data-testid="admission-queue-unreachable">
          {t("users.queue.unreachable", "Could not load sign-up requests.")}
        </span>
      );
    }
    if (queue.length === 0) {
      return <span data-testid="admission-queue-empty">{t("users.queue.empty", "No sign-up requests are waiting.")}</span>;
    }

    return (
      <ul data-testid="admission-queue-list" style={{ margin: 0, paddingLeft: 18 }}>
        {queue.map((pending) => {
          const isConfirming = confirmingDecision?.login === pending.github_login;
          return (
            <li key={pending.github_login} data-testid={`admission-row-${pending.github_login}`}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <span>
                  {pending.github_login}
                  {pending.requested_at ? (
                    <span style={{ color: "var(--color-text-muted)" }}> · {pending.requested_at}</span>
                  ) : null}
                </span>
                {withDecisions && !isConfirming ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`approve-admission-${pending.github_login}`}
                      disabled={deciding !== null}
                      onClick={() => {
                        setConfirmingDecision({ login: pending.github_login, decision: "approve" });
                        setDecisionError(null);
                        setDecisionNotice(null);
                      }}
                    >
                      {t("users.queue.approve", "Approve request")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      data-testid={`reject-admission-${pending.github_login}`}
                      disabled={deciding !== null}
                      onClick={() => {
                        setConfirmingDecision({ login: pending.github_login, decision: "deny" });
                        setDecisionError(null);
                        setDecisionNotice(null);
                      }}
                    >
                      {t("users.queue.reject", "Reject request")}
                    </Button>
                  </div>
                ) : null}
                {withDecisions && isConfirming ? (
                  <div
                    data-testid={`confirm-admission-${pending.github_login}`}
                    style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}
                  >
                    <span style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                      {confirmingDecision.decision === "approve"
                        ? t("users.queue.confirmApprove", "Approve this account sign-up request?")
                        : t("users.queue.confirmReject", "Reject this account sign-up request?")}
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Button
                        type="button"
                        size="sm"
                        variant={confirmingDecision.decision === "approve" ? "primary" : "danger"}
                        data-testid={`confirm-admission-submit-${pending.github_login}`}
                        disabled={deciding !== null}
                        onClick={() => void decideAdmission(pending.github_login, confirmingDecision.decision)}
                      >
                        {deciding === pending.github_login
                          ? t("users.queue.deciding", "Saving decision…")
                          : confirmingDecision.decision === "approve"
                            ? t("users.queue.confirmApproval", "Confirm approval")
                            : t("users.queue.confirmRejection", "Confirm rejection")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        data-testid={`confirm-admission-cancel-${pending.github_login}`}
                        disabled={deciding !== null}
                        onClick={() => setConfirmingDecision(null)}
                      >
                        {t("common.cancel", "Cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} data-testid="user-admin">
      <Breadcrumbs />
      <PageHeader
        title={t("users.title", "Local accounts")}
        subtitle={t(
          "users.subtitle",
          "Create and manage accounts used without external sign-in. A temporary password is shown once after creation and must be changed at first sign-in.",
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
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
          <strong>{t("users.create.title", "Create local account")}</strong>
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            {t(
              "users.password.help",
              "After account creation or password reissue, the temporary password appears once in the confirmation panel below.",
            )}
          </span>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.username", "Username")}
          <input
            data-testid="admit-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("users.field.username.ph", "letters, digits and dashes")}
            required
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-bg-surface)",
              color: "var(--color-text-primary)",
              cursor: "text",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.display", "Name")}
          <input
            data-testid="admit-display"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("users.field.display.ph", "Optional display name")}
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-bg-surface)",
              color: "var(--color-text-primary)",
              cursor: "text",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.tenant", "Tenant")}
          <select
            data-testid="admit-tenant"
            value={selectedTenant}
            onChange={(event) => setSelectedTenant(event.target.value)}
            disabled={tenantLoading || tenants === null || tenants.length === 0}
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              color: "var(--color-text-primary)",
              minWidth: 180,
            }}
          >
            {tenantLoading ? (
              <option value="">{t("users.tenants.loading", "Reading tenants…")}</option>
            ) : tenants?.length ? (
              tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.id})
                </option>
              ))
            ) : (
              <option value="">{t("users.tenants.none", "No tenant can be selected")}</option>
            )}
          </select>
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("users.field.role", "Initial role")}
          <span
            data-testid="admit-role"
            aria-describedby="admit-role-help"
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              color: "var(--color-text-secondary)",
              minWidth: 190,
              fontWeight: 700,
            }}
          >
            {t("users.role.member", "Standard account")}
          </span>
          <span id="admit-role-help" style={{ maxWidth: 260, color: "var(--color-text-muted)", lineHeight: 1.45 }}>
            {t(
              "users.role.initialNote",
              "New accounts start as Standard account. Assign additional permissions after creation on Account permissions.",
            )}{" "}
            <a href="/tenant/rbac" style={{ color: "var(--color-primary)", fontWeight: 700 }}>
              {t("users.role.openPermissions", "Open account permissions")}
            </a>
          </span>
        </div>
        <Button
          type="submit"
          data-testid="admit-submit"
          disabled={busy || tenantLoading || tenants === null || tenants.length === 0 || !selectedTenant}
        >
          {busy ? t("users.admitting", "Creating account…") : t("users.admit", "Create account")}
        </Button>
      </form>

      {!tenantLoading && tenants === null ? (
        <div
          data-testid={tenantFailure === "refused" ? "admit-tenants-refused" : "admit-tenants-unreachable"}
          style={{
            padding: 12,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontSize: "0.85rem",
          }}
        >
          {tenantFailure === "refused"
            ? refusedText(t, tenantMissing)
            : t("users.tenants.unreachable", "The tenant list could not be read. No tenant has been assumed.")}
        </div>
      ) : null}

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

      {reissueRefusal && (
        <div
          data-testid="reissue-error"
          style={{
            padding: 12,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontSize: "0.85rem",
          }}
        >
          {reissueRefusal}
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
            {issued.action === "created"
              ? t("users.issued.created", "Account created — temporary password for")
              : t("users.issued.reissued", "Password reissued — temporary password for")} {issued.username}
          </strong>
          <code data-testid="issued-value" style={{ fontSize: "1rem", letterSpacing: "0.02em" }}>
            {issued.password}
          </code>
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            {t(
              "users.issued.once",
              "Shown once. Deliver it securely now. Leaving or reloading this page removes it; if it is lost, use Reissue temporary password in the account list.",
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
        <strong>{t("users.queue.title", "Sign-up requests")}</strong>
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          {t(
            "users.queue.hint",
            "This list shows account sign-up requests. The notification bell shows agent registration key requests.",
          )}
        </span>

        {!approvalOpen ? renderQueue(false) : null}

        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
          {t("users.queue.decide", "Approve or reject requests here in the console.")}{" "}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="open-admission-approval"
            aria-expanded={approvalOpen}
            aria-controls="admission-decision-panel"
            onClick={() => {
              setApprovalOpen((current) => !current);
              setConfirmingDecision(null);
              setDecisionError(null);
            }}
          >
            {approvalOpen
              ? t("users.queue.closeApproval", "Close account approval")
              : t("users.queue.openApproval", "Open account approval")}
          </Button>
        </span>

        {approvalOpen ? (
          <div
            id="admission-decision-panel"
            data-testid="admission-decision-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 12,
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-bg-surface-sub)",
            }}
          >
            <strong>{t("users.queue.approvalTitle", "Account approval")}</strong>
            {decisionError ? (
              <span data-testid="admission-decision-error" style={{ color: "var(--color-danger)" }}>
                {decisionError}
              </span>
            ) : null}
            {decisionNotice ? (
              <span data-testid="admission-decision-success" style={{ color: "var(--color-primary)" }}>
                {decisionNotice.decision === "approve"
                  ? t("users.queue.approved", "Request approved:")
                  : t("users.queue.rejected", "Request rejected:")} {decisionNotice.login}
              </span>
            ) : null}
            {renderQueue(true)}
          </div>
        ) : null}
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
