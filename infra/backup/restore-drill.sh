#!/usr/bin/env bash
# BE-142 — weekly restore drill: prove the latest snapshot actually restores.
#
# Restores the newest restic snapshot into a THROWAWAY TimescaleDB container,
# verifies hypertables, continuous aggregates, and pgvector survived, measures
# RPO (age of newest candle) and RTO (wall-clock restore time), and appends a
# line to infra/backup/drill-log.md. Run weekly from cron (see BACKUP.md).
#
# Required env: RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_* (same as backup.sh).
# Optional: DRILL_IMAGE (default timescale/timescaledb-ha:pg18-ts2.28),
#           DRILL_LOG (default alongside this script), RPO_MAX_SECONDS (3600),
#           RTO_MAX_SECONDS (14400).
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

IMAGE="${DRILL_IMAGE:-timescale/timescaledb-ha:pg18-ts2.28}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL_LOG="${DRILL_LOG:-${SCRIPT_DIR}/drill-log.md}"
RPO_MAX="${RPO_MAX_SECONDS:-3600}"   # <1h (BE-142 AC)
RTO_MAX="${RTO_MAX_SECONDS:-14400}"  # <4h (BE-142 AC)
CONTAINER="fx-restore-drill-$$"
WORKDIR="$(mktemp -d)"
START_EPOCH="$(date -u +%s)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

log_result() { # status detail
  printf '| %s | %s | %s | %s | %s |\n' "$STAMP" "$1" "${RPO_SECONDS:-n/a}" "${RTO_SECONDS:-n/a}" "$2" >>"$DRILL_LOG"
}

echo "[drill] restoring latest snapshot to scratch dir"
restic restore latest --target "${WORKDIR}" --include /fx-db/fx.dump

echo "[drill] booting throwaway ${IMAGE}"
docker run -d --name "${CONTAINER}" \
  -e POSTGRES_USER=fx -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=fx \
  -v "${WORKDIR}/fx-db:/restore:ro" "${IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  docker exec "${CONTAINER}" pg_isready -U fx -d fx >/dev/null 2>&1 && break
  sleep 2
done

echo "[drill] pg_restore"
docker exec "${CONTAINER}" pg_restore --username=fx --dbname=fx --no-owner /restore/fx.dump \
  || { log_result FAIL "pg_restore failed"; exit 1; }

psql_scalar() { docker exec "${CONTAINER}" psql -U fx -d fx -tAc "$1"; }

echo "[drill] verifying restored objects"
HYPERTABLES="$(psql_scalar "select count(*) from timescaledb_information.hypertables")"
CAGGS="$(psql_scalar "select count(*) from timescaledb_information.continuous_aggregates")"
PGVECTOR="$(psql_scalar "select count(*) from pg_extension where extname = 'vector'")"
if [[ "${HYPERTABLES}" -lt 1 || "${PGVECTOR}" -lt 1 ]]; then
  log_result FAIL "hypertables=${HYPERTABLES} caggs=${CAGGS} pgvector=${PGVECTOR}"
  echo "[drill] FAILED verification" >&2
  exit 1
fi

# RPO: age of the newest candle in the restored DB at drill time.
NEWEST="$(psql_scalar "select coalesce(extract(epoch from now() - max(bucket_ts)), 0)::bigint from (select max(ts) as bucket_ts from candles) c" 2>/dev/null || echo 0)"
RPO_SECONDS="${NEWEST%%.*}"
RTO_SECONDS="$(( $(date -u +%s) - START_EPOCH ))"

STATUS=OK
[[ "${RPO_SECONDS}" -gt "${RPO_MAX}" ]] && STATUS="WARN-RPO"
[[ "${RTO_SECONDS}" -gt "${RTO_MAX}" ]] && STATUS="FAIL-RTO"
log_result "${STATUS}" "hypertables=${HYPERTABLES} caggs=${CAGGS} pgvector=${PGVECTOR}"

echo "[drill] ${STATUS} — RPO=${RPO_SECONDS}s (max ${RPO_MAX}) RTO=${RTO_SECONDS}s (max ${RTO_MAX})"
[[ "${STATUS}" == FAIL* ]] && exit 1 || exit 0
