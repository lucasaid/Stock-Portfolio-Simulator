import { useState } from 'react';
import { usePlaceOrder } from '../../api/hooks';
import type { PositionRow, RoundStatus, TradeResult } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { dollarsToCents, formatCents } from '../../lib/format';

/** Mirrors TERMINAL in backend/src/rounds/service.ts — canTrade() rejects these outright. */
const TERMINAL: RoundStatus[] = ['goal_reached', 'busted', 'archived'];

export function OrderForm({
  roundId,
  status,
  positions,
  watchlist,
}: {
  roundId: number;
  status: RoundStatus;
  positions: PositionRow[];
  watchlist: string[];
}) {
  const place = usePlaceOrder(roundId);
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sellAll, setSellAll] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);

  const frozen = TERMINAL.includes(status);
  const amountCents = dollarsToCents(amount);
  const qty = Number(quantity);
  const valid =
    !frozen &&
    symbol.trim() !== '' &&
    (side === 'buy' ? amountCents !== null && amountCents > 0 : sellAll || (Number.isFinite(qty) && qty > 0));

  const suggestions = [...new Set([...watchlist, ...positions.map((p) => p.symbol)])];

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        const body =
          side === 'buy'
            ? { symbol: symbol.trim().toUpperCase(), side, amountCents: amountCents! }
            : { symbol: symbol.trim().toUpperCase(), side, quantity: sellAll ? ('all' as const) : qty };
        place.mutate(body, { onSuccess: setResult });
      }}
    >
      {frozen && <p className="muted">A {status} round cannot trade.</p>}

      <label>
        Side
        <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')} disabled={frozen}>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
      </label>

      <label>
        Symbol
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          list="order-symbols"
          disabled={frozen}
          placeholder="AAPL"
        />
      </label>
      <datalist id="order-symbols">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {side === 'buy' ? (
        <label>
          Amount to spend ($)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={frozen} />
        </label>
      ) : (
        <>
          <label className="row">
            <input type="checkbox" checked={sellAll} onChange={(e) => setSellAll(e.target.checked)} disabled={frozen} />
            Sell everything
          </label>
          {!sellAll && (
            <label>
              Quantity
              <input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                inputMode="decimal"
                disabled={frozen}
              />
            </label>
          )}
        </>
      )}

      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        Orders are rejected on stale quotes. Buys are clipped to available cash and the max-position guardrail.
      </p>

      <ErrorBox error={place.error} />
      {result?.status === 'filled' && (
        <p className="gain" style={{ margin: 0 }}>
          Filled{result.reason ? ` (${result.reason})` : ''}
          {result.skimCents > 0 ? ` — pocketed ${formatCents(result.skimCents)}` : ''}.
        </p>
      )}

      <button className="primary" type="submit" disabled={!valid || place.isPending}>
        Place order
      </button>
    </form>
  );
}
