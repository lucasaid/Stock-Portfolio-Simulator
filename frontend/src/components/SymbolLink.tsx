import { Link } from 'react-router-dom';

/** Jumps to the Markets page with this symbol's chart pre-selected — works for held or sold symbols alike. */
export function SymbolLink({ symbol }: { symbol: string }) {
  return (
    <Link to={`/markets?symbol=${encodeURIComponent(symbol)}`} style={{ color: 'inherit' }}>
      {symbol}
    </Link>
  );
}
