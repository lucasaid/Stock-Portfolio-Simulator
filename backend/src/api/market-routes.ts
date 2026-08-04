import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import { ALL_MARKETS } from '../market/adapters.js';
import type { CandidateFetcher, ScanCandidate } from '../market/candidates.js';
import { marketForSymbol, type MarketDataService } from '../market/data.js';
import { isRange, type MarketHistoryService } from '../market/history.js';
import { normalizeSymbol, type SymbolRegistry } from '../market/symbols.js';
import type { Market } from '../engine/types.js';
import { requireSession } from './middleware.js';

export function marketRoutes(
  auth: AuthService,
  history: MarketHistoryService,
  symbols: SymbolRegistry,
  market: MarketDataService,
  candidates: CandidateFetcher,
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

  /**
   * The AUD/USD rate the broker values USD fills at. Exposed so the UI can show
   * unrealised P/L on US holdings, whose cost basis is stored in AUD cents.
   */
  router.get('/api/market/fx', async (_req, res) => {
    try {
      res.json({ audUsd: await market.audUsdRate() });
    } catch (err) {
      // Never invent a rate: a wrong one silently misprices every US position.
      res.status(502).json({ error: `FX rate unavailable: ${(err as Error).message}` });
    }
  });

  /**
   * A grounded pool of real, currently-active symbols for the requested markets — reuses
   * the same Yahoo screener (most_actives + day_gainers) market-scan uses for its candidate
   * list, so the "Shuffle" watchlist button draws from real, currently-tradeable symbols
   * rather than only the handful already tracked in our own `symbols` table.
   *
   * Same defence market-scan applies (Defence 2): each market's pool is filtered by
   * `marketForSymbol` before being returned. This is NOT redundant — the Yahoo screener's
   * `region: 'AU'` call does not reliably return `.AX`-suffixed symbols (a documented,
   * verified coverage gap; see CLAUDE.md's market-scan section), so an ASX request can
   * otherwise come back full of unfiltered US symbols mislabeled as ASX candidates.
   */
  router.get('/api/market/candidates', async (req, res) => {
    const requested = String(req.query.markets ?? '')
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter((m) => m !== '');
    if (requested.length === 0 || !requested.every((m): m is Market => (ALL_MARKETS as string[]).includes(m))) {
      res.status(400).json({ error: `markets must be a comma-separated list of ${ALL_MARKETS.join(', ')}` });
      return;
    }
    try {
      const pools = await Promise.all(
        requested.map(async (m) => {
          const pool = await candidates(m as Market);
          return pool.filter((c) => marketForSymbol(c.symbol) === m);
        }),
      );
      const seen = new Map<string, ScanCandidate>();
      for (const pool of pools) for (const c of pool) if (!seen.has(c.symbol)) seen.set(c.symbol, c);
      res.json([...seen.values()]);
    } catch (err) {
      res.status(502).json({ error: `candidates unavailable: ${(err as Error).message}` });
    }
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
