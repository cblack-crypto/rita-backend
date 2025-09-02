![Smoke](https://github.com/ORG/REPO/actions/workflows/smoke.yml/badge.svg)

# Rita Backend Starter

Minimal, production-minded scaffold for the Rita AI backend (Fastify + TypeScript) with a Redis dependency and an optional Python simulator.

## Prereqs
- Node 18+
- pnpm (or npm/yarn). With Node 18+: `corepack enable && corepack prepare pnpm@latest --activate`
- Docker (for Redis), optional but recommended

## Quickstart
```bash
# 1) clone / unzip
cp .env.example .env

# 2) install deps
pnpm install

# 3) start Redis (docker)
docker compose up -d

# 4) run dev
pnpm dev

# 5) hit health
curl http://localhost:3000/health
```

## Scripts
- `pnpm dev` â€“ run with tsx
- `pnpm build` â€“ transpile to `dist/`
- `pnpm start` â€“ run built JS
- `pnpm test` â€“ run Vitest

## Optional Python Simulator
If you want to generate signed weight uploads from Python:
```bash
cd sim
python -m venv .venv && . .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python sim.py
```

## Structure
```text
src/
  server.ts
  config.ts
  utils/SecurityUtils.ts
  services/
    DatabaseService.ts
    AuthService.ts
    MetricsService.ts
    ModelVersioningService.ts
    StreamingFLAggregator.ts
tests/
  smoke.test.ts
docker-compose.yml
Dockerfile
```

