# stake_portfolio

Paper-trading agent. Claude-powered rounds trade ASX and US shares against a fixed bankroll,
and every sell that lifts cash above the starting balance skims the excess into a profit
ledger. Rounds pause at their goal and can be chained.

Worked example: start with $50 → buy $20 of something → sell it for $40 → cash is now $70 →
skim $20 into the profit ledger → cash back to $50. The skimmed money can never be lost.

## Quick start (Docker)

```bash
./scripts/setup.sh          # Claude auth, build, start, create the login
open http://localhost:8088
```

## Development

```bash
cd backend  && npm install && npm run dev    # API on :3000
cd frontend && npm install && npm run dev    # dashboard on :5173, proxies /api
```

```bash
cd backend  && npm test && npx tsc --noEmit
cd frontend && npm test && npx tsc --noEmit
```

Create the first user (the dashboard is gated by a login):

```bash
cd backend && npm run cli -- create-user <username>
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `DB_PATH` | `./data/stake.db` | SQLite database (WAL) |
| `COOKIE_SECURE` | `0` | Set to `1` when serving over TLS |
| `TRUST_PROXY` | `0` | Set to `1` behind nginx so rate limiting sees real client IPs |
| `ONECLI_API_HOST` | `http://onecli:10254` (compose) | Local OneCLI instance the backend process wraps itself against |
| `ONECLI_AGENT` | `default` | OneCLI agent identifier whose granted secrets get injected |

There is no `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` anywhere, by design.
The backend process itself is launched wrapped as `onecli run -- node dist/index.js`
(`docker-entrypoint.sh`), which transparently proxies its outbound HTTPS traffic through the local
OneCLI gateway (`HTTPS_PROXY` + a locally-trusted CA) and injects the real Anthropic subscription
token on the wire — the token never lands in this codebase's env or config files.

## Layout

- `backend/` — engine, market data, broker, rounds service, scheduler, API, Claude agent
- `frontend/` — React + Vite dashboard
- `docs/superpowers/` — the spec and the implementation plans
