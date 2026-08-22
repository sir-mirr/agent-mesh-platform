import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  AclMatrix,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { fetchGroups, addEgressRuleApi, deleteEgressRuleApi, type GroupItem } from "@/api/groups.ts";

export function TenantEgressAclPage() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [rules, setRules] = useState<Record<string, Record<string, boolean>>>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real groups and their allowed egress rules on mount
  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    setFailure(null);
    fetchGroups()
      .then((list) => {
        if (list && list.length > 0) {
          setGroups(list.map((g) => ({ id: g.id, name: g.name })));
          const nextRules: Record<string, Record<string, boolean>> = {};
          for (const g of list) {
            const row: Record<string, boolean> = {};
            for (const target of list) {
                // **No self-exception.** `maySend` has none either — its query is
                // `from_group = ? AND to_group = ?` and nothing else, and the comment
                // above it says so in words: *same-group sends still require a rule;
                // `default` has one, seeded; a group someone creates does not until
                // they say so, which is the point of asking.* Drawing the diagonal as
                // allowed said the opposite of what the server would answer for every
                // group but `default` — and `default` agreeing is why it went unseen.
                row[target.id] = (g.egress_allowed && g.egress_allowed.includes(target.id)) || false;
            }
            nextRules[g.id] = row;
          }
          setRules(nextRules);
        } else {
          setGroups([]);
          setRules({});
        }
      })
      .catch((err) => {
        console.warn("[Egress] fetchGroups error:", err);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
        setGroups([]);
        setRules({});
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleToggleRule = async (sourceId: string, targetId: string, currentAllowed: boolean) => {
    const nextAllowed = !currentAllowed;
    setRules({
      ...rules,
      [sourceId]: {
        ...(rules[sourceId] || {}),
        [targetId]: nextAllowed,
      },
    });

    try {
      if (nextAllowed) {
        await addEgressRuleApi(sourceId, targetId);
      } else {
        await deleteEgressRuleApi(sourceId, targetId);
      }
      const sourceName = groups.find((g) => g.id === sourceId)?.name || sourceId;
      const targetName = groups.find((g) => g.id === targetId)?.name || targetId;

      setToastMessage(
        `${t("egress.toast.updated", "전송 규칙 갱신")}: [${sourceName}] → [${targetName}] : ${nextAllowed ? t("acl.allow", "ALLOW (허용)") : t("acl.deny", "DENY (차단)")}`
      );
    } catch (err: any) {
      console.warn("[Egress] Rule toggle error:", err.message);
      setRules((prev) => ({
        ...prev,
        [sourceId]: {
          ...(prev[sourceId] || {}),
          [targetId]: currentAllowed,
        },
      }));
      setToastMessage(`${t("egress.toast.failed", "전송 규칙 변경 실패")}: ${err.message || t("overview.down", "통신 불가")}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("egress.title", "그룹 간 메시지 전송 규칙")}
        subtitle={t("egress.subtitle", "그룹 사이의 한 방향 메시지 전송을 허용하거나 차단합니다")}
      />

      {toastMessage && (
        <Toast
          type="info"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
          {t("egress.desc", "셀을 클릭하여 출발 그룹에서 도착 그룹으로 보내는 한 방향 메시지를 허용하거나 차단합니다.")}
        </p>

        {isLoading ? (
          <div style={{ padding: "30px", textAlign: "center", color: "var(--color-text-muted)" }}>
            {t("egress.loading", "그룹 간 전송 규칙을 불러오는 중입니다...")}
          </div>
        ) : isError ? (
          <div style={{ padding: "24px", background: "var(--color-bg-surface)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-lg)", color: "var(--color-danger)", textAlign: "center" }}>
            ⚠️{" "}
            {failure === "refused"
              ? refusedText(t, missing)
              : t("egress.error", "그룹 간 전송 규칙을 불러오지 못했습니다 (서버가 답하지 않았습니다).")}
          </div>
        ) : groups.length === 0 ? (
          <div style={{ padding: "30px", textAlign: "center", color: "var(--color-text-muted)", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", border: "1px solid var(--color-border)" }}>
            {t("egress.noGroups", "현재 등록된 그룹이 없어 전송 규칙 표를 표시할 수 없습니다.")}
          </div>
        ) : (
          <AclMatrix
            groups={groups}
            rules={rules}
            onToggleRule={handleToggleRule}
          />
        )}
      </div>
    </div>
  );
}
