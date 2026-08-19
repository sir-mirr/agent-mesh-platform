import React from "react";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { Modal } from "./Modal.tsx";
import { Button } from "@/components/common/Button.tsx";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  confirmPromptMatch?: string; // If provided, user must type this exact text to confirm (e.g. agent name)
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  isDestructive = false,
  isLoading = false,
  confirmPromptMatch,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const [matchInput, setMatchInput] = React.useState("");

  React.useEffect(() => {
    if (isOpen) setMatchInput("");
  }, [isOpen]);

  const isMatchValid = !confirmPromptMatch || matchInput === confirmPromptMatch;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isLoading}>
            {cancelLabel ?? t("confirm.cancel", "취소")}
          </Button>
          <Button
            variant={isDestructive ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            isLoading={isLoading}
            disabled={!isMatchValid}
          >
            {confirmLabel ?? t("confirm.ok", "확인")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p
          style={{
            fontSize: "0.88rem",
            color: "var(--color-text-secondary)",
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>

        {isDestructive && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--status-danger-bg)",
              border: "1px solid var(--status-danger-br)",
              borderRadius: "var(--radius-md)",
              fontSize: "0.8rem",
              color: "var(--status-danger)",
              fontWeight: 600,
            }}
          >
            ⚠️ {t("confirm.irreversible", "이 작업은 되돌릴 수 없습니다.")}
          </div>
        )}

        {confirmPromptMatch && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              style={{
                fontSize: "0.8rem",
                color: "var(--color-text-secondary)",
                fontWeight: 600,
              }}
            >
              {t("confirm.type", "확인하려면 다음을 그대로 입력하세요")}: <strong>`{confirmPromptMatch}`</strong>
            </label>
            <input
              type="text"
              value={matchInput}
              onChange={(e) => setMatchInput(e.target.value)}
              placeholder={confirmPromptMatch}
              style={{
                padding: "8px 12px",
                border: "1px solid var(--color-border-strong)",
                borderRadius: "var(--radius-md)",
                fontSize: "0.88rem",
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
