const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

/** Integer AUD cents → display string. Cents are the only money representation in this app. */
export function formatCents(cents: number): string {
  return AUD.format(cents / 100).replace('A$', '$');
}

/** Same, but always signed — for deltas, P/L and ledger amounts. */
export function signedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

const DOLLARS_RE = /^(\d+)(?:\.(\d*))?$/;

/**
 * Parse a user-entered dollar amount into integer cents.
 * Returns null for anything that is not a non-negative decimal, so callers can
 * block submission rather than sending NaN to the money path.
 *
 * The digits are parsed as a decimal string rather than multiplying a float by
 * 100: `1.005 * 100` is 100.49999999999999 in binary floating point, which would
 * round DOWN to $1.00. Sub-cent input rounds half-up on the third decimal.
 */
export function dollarsToCents(input: string): number | null {
  const match = DOLLARS_RE.exec(input.trim());
  if (match === null) return null;

  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(3, '0');
  const cents = Number(fraction.slice(0, 2));
  const roundUp = Number(fraction[2]) >= 5 ? 1 : 0;

  const total = whole * 100 + cents + roundUp;
  return Number.isSafeInteger(total) ? total : null;
}

export function formatPct(pct: number | null): string {
  return pct === null ? 'off' : `${pct.toFixed(1)}%`;
}

/** Share quantities are floats; ASX holdings are whole shares. */
export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(4)));
}

export function formatTs(iso: string, timezone = 'Australia/Sydney'): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatDay(iso: string, timezone = 'Australia/Sydney'): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}
