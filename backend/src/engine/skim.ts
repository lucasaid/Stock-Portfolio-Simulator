/** Spec §2.2: after a sell, pocket whatever cash exceeds the starting balance. */
export function computeSkimCents(cashCents: number, startingBalanceCents: number): number {
  return Math.max(0, cashCents - startingBalanceCents);
}
