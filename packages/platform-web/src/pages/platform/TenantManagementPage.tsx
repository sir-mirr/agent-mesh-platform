import React, { useEffect, useState } from "react";
import { Breadcrumbs, Button, DataTable, PageHeader } from "@/components/index.ts";
import {
  createTenantApi,
  deleteTenantApi,
  fetchTenantDirectory,
  renameTenantApi,
  type TenantDirectoryItem,
} from "@/api/tenants.ts";
import { ApiError, failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

/** Stable id seeded by T-026. Its display name may be renamed. */
export const DEFAULT_TENANT_ID = "default";

const fieldStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg-surface-sub)",
  color: "var(--color-text-primary)",
};

function writeError(t: (key: string, fallback: string) => string, err: unknown): string {
  return err instanceof ApiError && err.status === null
    ? t("tenantDirectory.writeUnreachable", "The server did not answer. The tenant state is unknown.")
    : String((err as { message?: unknown })?.message ?? err);
}

/**
 * The platform administrator's tenant directory.
 *
 * This is intentionally separate from `TenantTrafficPage`: traffic answers
 * which tenant ids moved messages in a time window, while this page reads the
 * directory that includes a newly-created tenant before it has any traffic and
 * retains a soft-deleted tenant afterwards.
 */
export function TenantManagementPage() {
  const { t } = useI18n();
  const [tenants, setTenants] = useState<TenantDirectoryItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    try {
      const response = await fetchTenantDirectory();
      if (!Array.isArray(response.tenants)) {
        throw new Error("tenant directory response did not include tenants");
      }
      setTenants(response.tenants);
      setFailure(null);
      setMissing(null);
    } catch (err: unknown) {
      // `null`, not `[]`: not reaching the directory is not proof that no
      // tenants exist, and a soft-deleted row must not disappear into that lie.
      setTenants(null);
      setFailure(failureKind(err));
      setMissing(refusedCapability(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = newId.trim();
    const name = newName.trim();
    if (!id || !name || busyKey) return;
    setBusyKey("create");
    setMutationError(null);
    setMutationNotice(null);
    try {
      const response = await createTenantApi(id, name);
      setMutationNotice(
        `${t("tenantDirectory.created", "Tenant created:")} ${response.tenant?.name ?? name}`,
      );
      setNewId("");
      setNewName("");
      await load();
    } catch (err: unknown) {
      setMutationError(writeError(t, err));
    } finally {
      setBusyKey(null);
    }
  };

  const beginRename = (tenant: TenantDirectoryItem) => {
    if (busyKey) return;
    setEditingId(tenant.id);
    setEditingName(tenant.name);
    setMutationError(null);
    setMutationNotice(null);
  };

  const rename = async (tenant: TenantDirectoryItem) => {
    const name = editingName.trim();
    if (editingId !== tenant.id || !name || busyKey) return;
    setBusyKey(`rename:${tenant.id}`);
    setMutationError(null);
    setMutationNotice(null);
    try {
      const response = await renameTenantApi(tenant.id, name);
      setMutationNotice(
        `${t("tenantDirectory.renamed", "Tenant renamed:")} ${response.tenant?.name ?? name}`,
      );
      setEditingId(null);
      setEditingName("");
      await load();
    } catch (err: unknown) {
      setMutationError(writeError(t, err));
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (tenant: TenantDirectoryItem) => {
    // Independent of the DOM's `disabled` bit. A developer-tools edit must not
    // turn the seeded tenant's grey button into a DELETE request.
    if (tenant.id === DEFAULT_TENANT_ID || tenant.deleted_at !== null || busyKey) return;
    if (!window.confirm(
      `${t("tenantDirectory.deleteConfirm", "Soft-delete this tenant?")} ${tenant.name} (${tenant.id})`,
    )) return;

    setBusyKey(`delete:${tenant.id}`);
    setMutationError(null);
    setMutationNotice(null);
    try {
      const response = await deleteTenantApi(tenant.id);
      setMutationNotice(
        response.action === "already-deleted"
          ? t("tenantDirectory.alreadyDeleted", "The tenant was already soft-deleted.")
          : response.action === "not-found"
            ? t("tenantDirectory.notFound", "The tenant did not exist; no row was deleted.")
            : t("tenantDirectory.deleted", "Tenant soft-deleted. Its row remains in the directory."),
      );
      await load();
    } catch (err: unknown) {
      setMutationError(writeError(t, err));
    } finally {
      setBusyKey(null);
    }
  };

  const columns = [
    {
      key: "name",
      header: t("tenantDirectory.col.name", "Name"),
      render: (tenant: TenantDirectoryItem) => editingId === tenant.id ? (
        <input
          data-testid={`tenant-rename-input-${tenant.id}`}
          value={editingName}
          onChange={(event) => setEditingName(event.target.value)}
          aria-label={`${t("tenantDirectory.rename", "Rename")} ${tenant.name}`}
          style={{ ...fieldStyle, width: "100%", minWidth: 160 }}
        />
      ) : (
        <strong data-testid={`tenant-name-${tenant.id}`}>{tenant.name}</strong>
      ),
    },
    {
      key: "id",
      header: t("tenantDirectory.col.id", "ID"),
      render: (tenant: TenantDirectoryItem) => (
        <code data-testid={`tenant-id-${tenant.id}`}>{tenant.id}</code>
      ),
    },
    {
      key: "status",
      header: t("tenantDirectory.col.status", "Status"),
      render: (tenant: TenantDirectoryItem) => (
        <div
          data-testid={`tenant-status-${tenant.id}`}
          data-deleted={tenant.deleted_at !== null ? "true" : "false"}
          style={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          <span
            style={{
              display: "inline-flex",
              alignSelf: "flex-start",
              padding: "2px 8px",
              borderRadius: "var(--radius-full)",
              fontSize: "0.74rem",
              fontWeight: 700,
              color: tenant.deleted_at ? "var(--color-text-muted)" : "var(--color-success)",
              background: tenant.deleted_at ? "var(--color-bg-surface-sub)" : "var(--color-success-light, #ECFDF5)",
              border: "1px solid var(--color-border)",
            }}
          >
            {tenant.deleted_at
              ? t("tenantDirectory.status.deleted", "Soft-deleted")
              : t("tenantDirectory.status.active", "Active")}
          </span>
          {tenant.deleted_at ? (
            <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>{tenant.deleted_at}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "actions",
      header: t("tenantDirectory.col.actions", "Actions"),
      render: (tenant: TenantDirectoryItem) => {
        const isDefault = tenant.id === DEFAULT_TENANT_ID;
        const isDeleted = tenant.deleted_at !== null;
        const deleteReason = isDefault
          ? t(
              "tenantDirectory.defaultDeleteReason",
              "The default tenant cannot be deleted because existing rows depend on it.",
            )
          : isDeleted
            ? t("tenantDirectory.deletedDeleteReason", "This tenant is already soft-deleted.")
            : undefined;

        return (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {editingId === tenant.id ? (
              <>
                <Button
                  size="sm"
                  data-testid={`tenant-rename-save-${tenant.id}`}
                  disabled={!editingName.trim() || busyKey !== null}
                  onClick={() => void rename(tenant)}
                >
                  {t("common.save", "Save")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`tenant-rename-cancel-${tenant.id}`}
                  disabled={busyKey !== null}
                  onClick={() => {
                    setEditingId(null);
                    setEditingName("");
                  }}
                >
                  {t("common.cancel", "Cancel")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                data-testid={`tenant-rename-${tenant.id}`}
                disabled={busyKey !== null}
                onClick={() => beginRename(tenant)}
              >
                {t("tenantDirectory.rename", "Rename")}
              </Button>
            )}

            <Button
              size="sm"
              variant="danger"
              data-testid={`tenant-delete-${tenant.id}`}
              data-fixed-default={isDefault ? "true" : undefined}
              data-soft-deleted={isDeleted ? "true" : undefined}
              disabled={isDefault || isDeleted || busyKey !== null}
              title={deleteReason}
              aria-label={deleteReason ?? `${t("tenantDirectory.delete", "Soft-delete")} ${tenant.name}`}
              onClick={() => void remove(tenant)}
              style={isDefault || isDeleted ? {
                opacity: 0.45,
                background: "var(--color-bg-surface-sub)",
                borderColor: "var(--color-border)",
                color: "var(--color-text-muted)",
              } : undefined}
            >
              {isDeleted
                ? t("tenantDirectory.deletedAction", "Deleted")
                : t("tenantDirectory.delete", "Soft-delete")}
            </Button>
            {deleteReason ? (
              <span
                data-testid={`tenant-delete-reason-${tenant.id}`}
                style={{ maxWidth: 260, fontSize: "0.72rem", color: "var(--color-text-muted)" }}
              >
                {deleteReason}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div data-testid="tenant-management" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />
      <PageHeader
        title={t("tenantDirectory.title", "Tenant management")}
        subtitle={t(
          "tenantDirectory.subtitle",
          "Create tenants, rename their display names, and soft-delete them without erasing their history.",
        )}
      />

      <form
        data-testid="tenant-create-form"
        onSubmit={create}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: 10,
          padding: 16,
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-surface)",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("tenantDirectory.field.id", "Tenant ID")}
          <input
            data-testid="tenant-create-id"
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            placeholder={t("tenantDirectory.field.idPlaceholder", "letters, digits and dashes")}
            style={fieldStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.8rem" }}>
          {t("tenantDirectory.field.name", "Display name")}
          <input
            data-testid="tenant-create-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            style={fieldStyle}
          />
        </label>
        <Button
          type="submit"
          data-testid="tenant-create-submit"
          disabled={!newId.trim() || !newName.trim() || busyKey !== null}
          isLoading={busyKey === "create"}
        >
          {t("tenantDirectory.create", "Create tenant")}
        </Button>
      </form>

      {mutationError ? (
        <div
          data-testid="tenant-mutation-error"
          style={{ padding: 12, border: "1px solid var(--color-danger)", borderRadius: 8, color: "var(--color-danger)" }}
        >
          {mutationError}
        </div>
      ) : null}
      {mutationNotice ? (
        <div
          data-testid="tenant-mutation-notice"
          style={{ padding: 12, border: "1px solid var(--color-success)", borderRadius: 8, color: "var(--color-success)" }}
        >
          {mutationNotice}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        data={tenants ?? []}
        keyExtractor={(tenant) => tenant.id}
        isLoading={isLoading}
        isError={!isLoading && tenants === null}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("tenantDirectory.error", "The tenant directory could not be read because the server did not answer.")
        }
        emptyMessage={t("tenantDirectory.empty", "The server reported no tenants.")}
      />
    </div>
  );
}
