/**
 * Which pinned scenarios a run could actually answer for.
 *
 * `pinned` is the claim: some manifest entry names this scenario. **A retired
 * entry carries no `from`**, so no run ever plants it and no night can observe
 * the scenario resting on it — comparing an observation against `pinned` fails
 * on a perfect night.
 *
 * Split into its own module for a reason worth stating: the check that this
 * distinction still exists could not fail while `scenario-anchors.ts` computed
 * it inline. The only case that separates `provable` from `pinned` is a
 * scenario pinned solely by a retired entry, and the day the last of those got
 * a plantable pin, the two numbers agreed on the real manifest and the guard
 * went quiet. The manifest cannot be asked to keep a hole open for a test's
 * benefit, so the reading moved here where synthetic inputs can hold one.
 */

export interface Provable {
  /** Scenarios some entry a run can plant will tick. */
  provable: string[];
  /** Pinned, and only by entries no run can plant. */
  onlyRetired: string[];
}

export function provableFrom(
  ids: readonly string[],
  proofs: ReadonlyMap<string, readonly string[]>,
  plantable: ReadonlySet<string>,
): Provable {
  const canPlant = (id: string) => (proofs.get(id) ?? []).some((entry) => plantable.has(entry));
  return {
    provable: ids.filter(canPlant),
    onlyRetired: ids.filter((id) => proofs.has(id) && !canPlant(id)),
  };
}
