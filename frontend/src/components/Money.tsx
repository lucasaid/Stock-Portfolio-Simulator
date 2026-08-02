import { formatCents, signedCents } from '../lib/format';

export function Money({ cents, signed = false }: { cents: number; signed?: boolean }) {
  const className = cents > 0 ? 'gain' : cents < 0 ? 'loss' : undefined;
  return <span className={signed ? className : undefined}>{signed ? signedCents(cents) : formatCents(cents)}</span>;
}
