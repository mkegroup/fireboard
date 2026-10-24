#!/bin/bash
# Usage: supabase/tests/run.sh   (needs a local postgres on PGHOST/PGPORT)
set -e
cd "$(dirname "$0")/../.."
P="psql -h ${PGHOST:-/var/tmp/fgbpg} -p ${PGPORT:-5499} -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists fgb" -c "create database fgb" >/dev/null 2>&1
$P -d fgb -f supabase/tests/00_supabase_stub.sql 2>&1 | grep -vi "wal_level\|logical" || true
for f in supabase/migrations/*.sql; do $P -d fgb -f "$f"; done
OUT=$($P -d fgb -At -f supabase/tests/01_rls_tests.sql 2>&1 || true)
echo "$OUT" | grep -E "ERROR|FAIL|ALL_TESTS_PASSED|expected" || true
echo "$OUT" | grep -q ALL_TESTS_PASSED
