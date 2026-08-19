import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/api/client.ts";
import { changePasswordApi } from "@/api/auth.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";

/**
 * The one screen a first login can reach.
 *
 * The server answers `403` to every other route while the account still holds
 * the password it was seeded with, so this is not a redirect that politely
 * suggests changing it — it is the only thing the session can do. The screen
 * says that, rather than leaving somebody to work out why the rest of the
 * product is refusing them.
 *
 * `current` is asked for again because a cookie left on an unattended screen
 * must not be enough to take the account.
 */
export function ChangePasswordPage() {
  const navigate = useNavigate();
  const { refreshSession } = useAuth();
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError(t("pwchg.mismatch", "The new password and its confirmation do not match."));
      return;
    }
    setBusy(true);
    try {
      await changePasswordApi(current, next);
    } catch (err: any) {
      // Said, not swallowed. A form that does nothing and explains nothing is
      // the shape this repository spent a day removing.
      setError(
        err instanceof ApiError && !err.refused
          ? t("pwchg.unreachable", "The server cannot be reached — this is not a problem with what you typed.")
          : err?.message || t("pwchg.failed", "The password was not changed."),
      );
      setBusy(false);
      return;
    }
    // Ask the server what it now says rather than assuming the flag cleared.
    await refreshSession();
    setBusy(false);
    navigate("/dashboard", { replace: true });
  };

  const label: React.CSSProperties = { fontSize: "0.8rem", color: "var(--color-text-muted)" };
  const input: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-surface)",
    color: "var(--color-text)",
    fontSize: "0.9rem",
  };

  return (
    <div
      data-testid="change-password"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "var(--color-bg)",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          width: "min(420px, 100%)",
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 28,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <strong style={{ fontSize: "1.05rem" }}>{t("pwchg.title", "Choose a password")}</strong>
          <span style={label}>
            {t(
              "pwchg.why",
              "This account is still using the password the deployment gave it. Nothing else opens until it is changed — the screen is not what refuses, the server is.",
            )}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>{t("pwchg.current", "Current password")}</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} style={input} required />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>{t("pwchg.next", "New password (8 characters or more)")}</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={input} required />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={label}>{t("pwchg.confirm", "Confirm new password")}</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={input} required />
        </div>

        {error && (
          <div
            data-testid="change-password-error"
            style={{
              border: "1px solid var(--color-danger, #EF4444)",
              borderRadius: "var(--radius-md)",
              padding: "10px 12px",
              fontSize: "0.85rem",
              color: "var(--color-danger, #EF4444)",
            }}
          >
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} style={{ ...input, cursor: busy ? "wait" : "pointer", fontWeight: 700 }}>
          {busy ? t("pwchg.busy", "Changing…") : t("pwchg.submit", "Change password")}
        </button>
      </form>
    </div>
  );
}
