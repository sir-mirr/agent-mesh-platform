export type OwnershipAction = "register-proxy" | "send-as";

export interface OwnershipCheck {
  ownerIdentity: string;
  requestedIdentity: string;
  action: OwnershipAction;
}

export interface OwnershipPolicy {
  assertCanRegisterProxy(check: OwnershipCheck): Promise<void> | void;
  assertCanSendAs(check: OwnershipCheck): Promise<void> | void;
}

export class OwnershipViolationError extends Error {
  readonly ownerIdentity: string;
  readonly requestedIdentity: string;
  readonly action: OwnershipAction;

  constructor(check: OwnershipCheck) {
    super(
      `ownership violation: ${check.ownerIdentity} cannot ${check.action} ${check.requestedIdentity}`,
    );
    this.name = "OwnershipViolationError";
    this.ownerIdentity = check.ownerIdentity;
    this.requestedIdentity = check.requestedIdentity;
    this.action = check.action;
  }
}

export async function assertProxyRegistration(
  policy: OwnershipPolicy | undefined,
  ownerIdentity: string,
  proxiedIdentity: string,
): Promise<void> {
  await policy?.assertCanRegisterProxy({
    ownerIdentity,
    requestedIdentity: proxiedIdentity,
    action: "register-proxy",
  });
}

export async function resolveEffectiveSender(
  policy: OwnershipPolicy | undefined,
  ownerIdentity: string,
  requestedIdentity?: string,
): Promise<string> {
  if (!requestedIdentity || requestedIdentity === ownerIdentity) return ownerIdentity;
  await policy?.assertCanSendAs({
    ownerIdentity,
    requestedIdentity,
    action: "send-as",
  });
  return requestedIdentity;
}
