#!/usr/bin/env bash
# Runs the database migrations and security-rule tests against a throwaway PostgreSQL database.
# Usage: DATABASE_URL=postgres://user:pass@host:5432/postgres scripts/test-db.sh
# The target must be a disposable local/CI server, never a Supabase project.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL server}"
case "$DATABASE_URL" in
  *supabase.co*|*supabase.com*) echo "Refusing to run tests against Supabase." >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="verify_test_$$"
ADMIN_URL="$DATABASE_URL"

psql "$ADMIN_URL" -qX -v ON_ERROR_STOP=1 -c "create database $DB"
trap 'psql "$ADMIN_URL" -qX -c "drop database if exists $DB" >/dev/null' EXIT

TEST_URL="${DATABASE_URL%/*}/$DB"
# repo_root lets a test file read a fixture shared with the TypeScript tests (M8: risk_vectors.json).
run() { psql "$TEST_URL" -qX -v ON_ERROR_STOP=1 -v repo_root="$ROOT" -f "$1"; }

run "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migration: $(basename "$f")"
  run "$f"
done
for f in "$ROOT"/supabase/tests/[1-9]*_test.sql; do
  echo "tests: $(basename "$f")"
  run "$f" 2>&1 | sed -n 's/^psql:.*NOTICE:  //p; /ERROR/p'
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
done
echo "All database tests passed."
