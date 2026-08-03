import { CRON_PRESETS, nextRunLabel } from '../lib/cron';

/**
 * One cron-per-line textarea plus preset buttons and a live "next run" preview per
 * line. The textarea stays the raw/advanced escape hatch — presets just insert text.
 */
export function CronScheduleField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const lines = value.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  return (
    <div className="grid" style={{ gap: '0.3rem' }}>
      <label>
        Check-in schedule (one cron expression per line)
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(value.trim() === '' ? preset.expression : `${value}\n${preset.expression}`)}
          >
            + {preset.label}
          </button>
        ))}
      </div>

      {lines.length > 0 && (
        <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.85em' }}>
          {lines.map((line) => {
            const label = nextRunLabel(line);
            return (
              <li key={line}>
                <code>{line}</code> — {label === null ? "can't parse this schedule" : `next run ${label}`}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
