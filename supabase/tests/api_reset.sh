#!/bin/bash
# Rebuilds the fgbapi test database (used by the PostgREST integration test).
set -e
cd "$(dirname "$0")/../.."
P="psql -h ${PGHOST:-/var/tmp/fgbpg} -p ${PGPORT:-5499} -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists fgbapi" -c "create database fgbapi" >/dev/null 2>&1
$P -d fgbapi -f supabase/tests/00_supabase_stub.sql >/dev/null 2>&1
for f in supabase/migrations/*.sql; do $P -d fgbapi -f "$f"; done
echo API_DB_READY
