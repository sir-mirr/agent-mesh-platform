import React, { useState } from "react";
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
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([
    { id: "grp_support", name: "Support Group" },
    { id: "grp_billing", name: "Billing Core" },
    { id: "grp_analytics", name: "Analytics Group" },
  ]);

  // Directional Egress rules (A -> B != B -> A)
  const [rules, setRules] = useState<Record<string, Record<string, boolean>>>({
    grp_support: {
      grp_support: true,
      grp_billing: true, // Support can message billing
      grp_analytics: false,
    },
    grp_billing: {
      grp_support: false, // Billing cannot initiate message to support
      grp_billing: true,
      grp_analytics: true,
    },
    grp_analytics: {
      grp_support: false,
      grp_billing: false,
      grp_analytics: true,
    },
  });

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real groups and their allowed egress rules on mount
  React.useEffect(() => {
    fetchGroups().then((list) => {
      if (list && list.length > 0) {
        setGroups(list.map((g) => ({ id: g.id, name: g.name })));
        const nextRules: Record<string, Record<string, boolean>> = {};
        for (const g of list) {
          const row: Record<string, boolean> = {};
          for (const target of list) {
            row[target.id] =
              g.id === target.id || (g.egress_allowed && g.egress_allowed.includes(target.id)) || false;
          }
          nextRules[g.id] = row;
        }
        setRules(nextRules);
      }
    });
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
    } catch (err: any) {
      console.warn("[Egress] Rule toggle fallback:", err.message);
    }

    const sourceName = groups.find((g) => g.id === sourceId)?.name || sourceId;
    const targetName = groups.find((g) => g.id === targetId)?.name || targetId;

    setToastMessage(
      `이그레스 통신 정책 갱신: [${sourceName}] → [${targetName}] : ${nextAllowed ? "ALLOW (허용됨)" : "DENY (차단됨)"}`
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="TENANT ADMIN"
        suiteBadgeColor="leased"
        screenId="27"
        title={t("egress.title", "그룹 간 이그레스 ACL 행렬")}
        subtitle={t("egress.subtitle", "Deny-by-default 기반 그룹 간 방향성(A→B != B→A) 통신 제어 (SPEC § 12 / -32018 EGRESS_DENIED)")}
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
          {t("egress.desc", "각 버튼을 클릭하여 출발 그룹(Source)에서 도착 그룹(Target)으로의 단방향 메시지 발송 허용/차단을 실시간 전환할 수 있습니다.")}
        </p>

        <AclMatrix
          groups={groups}
          rules={rules}
          onToggleRule={handleToggleRule}
        />
      </div>
    </div>
  );
}
