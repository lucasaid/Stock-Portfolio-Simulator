import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useArchiveSymbol, useFxRate, useHistory, useSettings, useSymbols, useTrackSymbol, useTradesForSymbol,
} from '../api/hooks';
import type { ChartRange } from '../api/types';
import { PriceChart } from '../components/charts/PriceChart';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { usdToAud } from '../lib/format';

const RANGES: ChartRange[] = ['1D', '1W', '1M', '3M', 'ALL'];
const MA_WINDOWS = [0, 5, 10, 20, 50];

function symbolLabel(row: { symbol: string; name: string | null; market: string }): string {
  return row.name === null ? row.symbol : `${row.symbol} — ${row.name} (${row.market})`;
}

export function MarketsPage() {
  const symbols = useSymbols();
  const settings = useSettings();
  const track = useTrackSymbol();
  const archive = useArchiveSymbol();

  // The selected symbol is mirrored into `?symbol=` so links from elsewhere in the app
  // (held positions, trade history) can land here already showing that symbol's chart.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelectedState] = useState(() => searchParams.get('symbol') ?? '');
  const [range, setRange] = useState<ChartRange>('1M');
  const [style, setStyle] = useState<'line' | 'candles'>(settings.data?.lookAndFeel.chartStyle ?? 'line');
  const [ma, setMa] = useState(0);
  const [newSymbol, setNewSymbol] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');

  useEffect(() => {
    const paramSymbol = searchParams.get('symbol');
    if (paramSymbol !== null && paramSymbol !== selected) setSelectedState(paramSymbol);
    // Only react to the URL changing (e.g. a new incoming link) — not every `selected` update,
    // or picking a symbol via the button list below would immediately overwrite itself.
  }, [searchParams]);

  function selectSymbol(symbol: string) {
    setSelectedState(symbol);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('symbol', symbol);
      return next;
    });
  }

  const history = useHistory(selected, range);
  const { trades } = useTradesForSymbol(selected);
  const fx = useFxRate();

  const bars = history.data?.bars ?? [];
  const changePct = bars.length >= 2 ? ((bars[bars.length - 1]!.close - bars[0]!.close) / bars[0]!.close) * 100 : null;
  const isUsd = history.data?.currency === 'USD';
  const lastClose = bars.length > 0 ? bars[bars.length - 1]!.close : null;
  const lastCloseAud = isUsd && lastClose !== null ? usdToAud(lastClose, fx.data?.audUsd) : null;

  const active = (symbols.data ?? []).filter((s) => s.archived === 0);
  const archived = (symbols.data ?? []).filter((s) => s.archived === 1);

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Markets</h1>

      <div className="panel grid">
        <div className="row">
          <button
            onClick={() => setView('active')}
            className={view === 'active' ? 'primary' : undefined}
          >
            Active ({active.length})
          </button>
          <button
            onClick={() => setView('archived')}
            className={view === 'archived' ? 'primary' : undefined}
          >
            Archived ({archived.length})
          </button>
        </div>

        <div className="row">
          {symbols.isPending && <Spinner label="Loading symbols" />}
          {view === 'active' &&
            active.map((row) => (
              <button
                key={row.symbol}
                onClick={() => selectSymbol(row.symbol)}
                className={selected === row.symbol ? 'primary' : undefined}
              >
                {symbolLabel(row)}
              </button>
            ))}
          {view === 'active' && active.length === 0 && !symbols.isPending && (
            <span className="muted">No tracked symbols yet.</span>
          )}
          {view === 'archived' &&
            archived.map((row) => (
              <button key={row.symbol} onClick={() => archive.mutate({ symbol: row.symbol, archived: false })}>
                {symbolLabel(row)} — restore
              </button>
            ))}
          {view === 'archived' && archived.length === 0 && !symbols.isPending && (
            <span className="muted">No archived symbols.</span>
          )}
        </div>

        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (newSymbol.trim() === '') return;
            track.mutate(newSymbol, { onSuccess: () => setNewSymbol('') });
          }}
        >
          <label>
            Track a symbol
            <input value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} placeholder="TSLA" />
          </label>
          <button type="submit" disabled={track.isPending}>
            Track
          </button>
        </form>
        <ErrorBox error={track.error} />
      </div>

      {selected === '' ? (
        <p className="muted">Pick a symbol to chart it.</p>
      ) : (
        <div className="panel grid">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{selected}</strong>
            {changePct !== null && (
              <span className={changePct >= 0 ? 'gain' : 'loss'}>
                {changePct >= 0 ? '+' : ''}
                {changePct.toFixed(1)}%
              </span>
            )}
          </div>

          <div className="row">
            {RANGES.map((option) => (
              <button key={option} onClick={() => setRange(option)} className={range === option ? 'primary' : undefined}>
                {option}
              </button>
            ))}
            <button onClick={() => setStyle(style === 'line' ? 'candles' : 'line')}>
              {style === 'line' ? 'Candles' : 'Line'}
            </button>
            <label>
              Moving average
              <select value={ma} onChange={(e) => setMa(Number(e.target.value))}>
                {MA_WINDOWS.map((window) => (
                  <option key={window} value={window}>
                    {window === 0 ? 'off' : `${window} bars`}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => archive.mutate({ symbol: selected, archived: true })}>Archive</button>
          </div>

          {history.isPending && <Spinner label="Loading history" />}
          <ErrorBox error={history.error} />
          {history.data?.stale && (
            <p className="loss" style={{ margin: 0 }}>
              Showing last known prices — the market data fetch failed.
            </p>
          )}
          {history.data && (
            <PriceChart bars={bars} style={style} trades={trades} movingAverage={ma === 0 ? undefined : ma} />
          )}
          <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
            {history.data ? `${history.data.interval} bars · ${history.data.currency}` : ''} · {trades.length} trade
            {trades.length === 1 ? '' : 's'} marked
            {isUsd && (lastCloseAud !== null ? ` · last ≈ $${lastCloseAud.toFixed(2)} AUD` : ' · AUD conversion unavailable')}
          </p>
        </div>
      )}
    </section>
  );
}
