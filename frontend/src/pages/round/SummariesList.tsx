import type { DailyDigest, SummaryRow } from '../../api/types';
import { formatCents, formatDay } from '../../lib/format';

function parseDigest(json: string): DailyDigest | null {
  try {
    const parsed = JSON.parse(json) as Partial<DailyDigest>;
    return typeof parsed.trades === 'number' ? (parsed as DailyDigest) : null;
  } catch {
    return null;
  }
}

export function SummariesList({ summaries }: { summaries: SummaryRow[] }) {
  if (summaries.length === 0) return <p className="muted">No daily summaries yet.</p>;

  // 'abstract' is the reserved lifetime slot (spec §4.3), not a calendar day.
  const abstract = summaries.find((s) => s.day === 'abstract');
  const days = summaries.filter((s) => s.day !== 'abstract').sort((a, b) => (a.day < b.day ? 1 : -1));

  return (
    <div className="grid">
      {abstract && (
        <section>
          <h3 style={{ margin: '0 0 0.3rem', fontSize: '0.95rem' }}>Lifetime abstract</h3>
          <p style={{ margin: 0 }}>{abstract.narrative}</p>
        </section>
      )}
      {days.map((summary) => {
        const digest = parseDigest(summary.digest_json);
        return (
          <section key={summary.day} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
            <h3 style={{ margin: '0 0 0.2rem', fontSize: '0.95rem' }}>{formatDay(`${summary.day}T00:00:00.000Z`)}</h3>
            <p style={{ margin: '0 0 0.3rem' }}>{summary.narrative ?? 'No narrative recorded.'}</p>
            {digest && (
              <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                {digest.trades} trades · {formatCents(digest.skimsCents)} pocketed · {formatCents(digest.feesCents)} fees ·{' '}
                {digest.tokensUsed.toLocaleString('en-AU')} tokens
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
