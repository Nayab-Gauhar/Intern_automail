#!/usr/bin/env bash
# Manage a user-space PostgreSQL cluster for local development.
#
# This machine has PostgreSQL 16 installed but the system service is disabled
# and we have no root access, so we run our own cluster owned by the current
# user. Data lives in .pgdata/ (gitignored). Port 5433 avoids colliding with
# any system cluster on 5432.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="$ROOT/.pgdata"
PGPORT="${PGPORT:-5433}"
LOGFILE="$ROOT/.pgdata/server.log"
DB_NAME="${DB_NAME:-instantmail}"
DB_USER="${DB_USER:-instantmail}"
DB_PASS="${DB_PASS:-instantmail}"

export PATH="$PGBIN:$PATH"

have_cluster() { [ -f "$PGDATA/PG_VERSION" ]; }
is_running()   { pg_ctl -D "$PGDATA" status >/dev/null 2>&1; }

init() {
  if have_cluster; then echo "cluster already initialised at $PGDATA"; return 0; fi
  echo "initialising cluster at $PGDATA"
  initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 >/dev/null
  # Listen on loopback only. This is a dev cluster; it must not be reachable
  # from the network.
  cat >> "$PGDATA/postgresql.conf" <<CONF

# ── local dev overrides ─────────────────────────────
port = $PGPORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PGDATA'
CONF
  start
  echo "creating role '$DB_USER' and database '$DB_NAME'"
  psql -h "$PGDATA" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS' CREATEDB;
CREATE DATABASE $DB_NAME OWNER $DB_USER;
CREATE DATABASE ${DB_NAME}_test OWNER $DB_USER;
SQL
  echo
  echo "ready. add to .env:"
  echo "  DATABASE_URL=\"postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$DB_NAME?schema=public\""
}

start() {
  have_cluster || { echo "no cluster yet — run: scripts/db.sh init" >&2; exit 1; }
  if is_running; then echo "already running on port $PGPORT"; return 0; fi
  pg_ctl -D "$PGDATA" -l "$LOGFILE" -w start >/dev/null
  echo "started on port $PGPORT"
}

stop() {
  if ! have_cluster || ! is_running; then echo "not running"; return 0; fi
  pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
  echo "stopped"
}

case "${1:-}" in
  init)    init ;;
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  is_running && echo "running on $PGPORT" || echo "stopped" ;;
  psql)    shift; psql -h "$PGDATA" -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" "$@" ;;
  logs)    tail -n "${2:-50}" "$LOGFILE" ;;
  destroy)
    read -rp "delete ALL local dev data at $PGDATA? [y/N] " ans
    [ "$ans" = "y" ] || { echo "aborted"; exit 0; }
    stop; rm -rf "$PGDATA"; echo "destroyed" ;;
  *) echo "usage: scripts/db.sh {init|start|stop|restart|status|psql|logs|destroy}" >&2; exit 1 ;;
esac
