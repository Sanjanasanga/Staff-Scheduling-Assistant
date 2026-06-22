#!/usr/bin/env bash
# One-command local run: installs deps, sets up the database, and starts both
# servers. Requires Node 18+ and a running PostgreSQL.
#
#   ./run.sh
#
# Backend → http://localhost:4100   Frontend → http://localhost:5173
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ Installing backend dependencies…"
( cd "Scheduling app backend" && npm install --no-audit --no-fund --silent )

echo "▸ Installing frontend dependencies…"
( cd "Scheduling app frontend" && npm install --no-audit --no-fund --silent )

echo "▸ Setting up the database (creates it if missing, seeds demo data)…"
( cd "Scheduling app backend" && npm run db:setup )

echo "▸ Starting backend + frontend…  (Ctrl-C to stop both)"
npx -y concurrently -k -n "backend,frontend" -c "blue,magenta" \
  "cd 'Scheduling app backend' && npm run dev" \
  "cd 'Scheduling app frontend' && npm run dev"
