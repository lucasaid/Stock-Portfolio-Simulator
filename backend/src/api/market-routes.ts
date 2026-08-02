import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { MarketDataService } from '../market/data.js';
import { isRange, type MarketHistoryService } from '../market/history.js';
import { normalizeSymbol, type SymbolRegistry } from '../market/symbols.js';
import { requireSession } from './middleware.js';

export function marketRoutes(
  auth: AuthService,
  history: MarketHistoryService,
  symbols: SymbolRegistry,
  market: MarketDataService,
): Router {
  const router = Router();
  router.use('/api/market', requireSession(auth));

  router.get('/api/market/history', async (req, res) => {
    const symbol = normalizeSymbol(String(req.query.symbol ?? ''));
    const range = req.query.range;
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    if (!isRange(range)) {
      res.status(400).json({ error: 'range must be one of 1D, 1W, 1M, 3M, ALL' });
      return;
    }
    try {
      res.json(await history.history(symbol, range));
    } catch (err) {
      res.status(502).json({ error: `history unavailable: ${(err as Error).message}` });
    }
  });

  router.get('/api/market/symbols', (_req, res) => {
    res.json(symbols.list());
  });

  router.post('/api/market/symbols', (req, res) => {
    const raw = (req.body as { symbol?: string } | undefined)?.symbol ?? '';
    const symbol = symbols.track(raw);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    res.status(201).json({ symbol });
  });

  router.post('/api/market/symbols/:symbol/archive', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    const archived = (req.body as { archived?: boolean } | undefined)?.archived ?? true;
    symbols.setArchived(symbol, archived);
    res.json({ symbol, archived });
  });

  router.get('/api/market/quotes', async (req, res) => {
    const requested = String(req.query.symbols ?? '')
      .split(',')
      .map((s) => normalizeSymbol(s))
      .filter((s): s is string => s !== null);
    if (requested.length === 0) {
      res.json({});
      return;
    }
    const quotes = await market.poll(requested);
    res.json(Object.fromEntries(quotes));
  });

  return router;
}
