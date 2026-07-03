#!/usr/bin/env bash
# BE-006 — Zero-downtime deploy to single-node Hetzner Swarm.
# Run ON the server from the repo checkout (or via .github/workflows/deploy.yml).
#
# Usage:
#   TAG=<git-sha> ./infra/deploy/deploy.sh
#
# Requires on the server: /etc/fx/deploy.env with REGISTRY, DOMAIN, ACME_EMAIL,
# DATABASE_URL, TRADING_MODE (see infra/DEPLOY.md §4).
set -euo pipefail

STACK=fx
ENV_FILE=${ENV_FILE:-/etc/fx/deploy.env}
TAG=${TAG:?usage: TAG=<git-sha> $0}
SERVICES=(api web quant)
TIMEOUT_SECS=${TIMEOUT_SECS:-300}

cd "$(dirname "$0")/../.."

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE not found — see infra/DEPLOY.md §4" >&2
  exit 1
fi
set -a; source "$ENV_FILE"; set +a
export TAG

echo "→ Deploying stack '$STACK' at tag $TAG (registry: $REGISTRY)"
docker stack deploy --with-registry-auth --prune -c infra/docker-stack.yml "$STACK"

# Healthcheck gate: wait until every service update converges. Swarm's
# failure_action=rollback reverts a service whose new task never turns healthy;
# we surface that as a failed deploy.
echo "→ Waiting for services to converge (timeout ${TIMEOUT_SECS}s)…"
deadline=$((SECONDS + TIMEOUT_SECS))
for svc in "${SERVICES[@]}"; do
  full="${STACK}_${svc}"
  while :; do
    state=$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' "$full")
    case "$state" in
      completed)
        echo "  ✅ $full converged"
        break
        ;;
      rollback_completed|rollback_paused|paused)
        echo "  ❌ $full rolled back (state: $state) — deploy failed" >&2
        exit 1
        ;;
      *)
        if (( SECONDS >= deadline )); then
          echo "  ❌ $full did not converge in ${TIMEOUT_SECS}s (state: $state)" >&2
          exit 1
        fi
        sleep 5
        ;;
    esac
  done
done

# Final smoke check through Caddy.
echo "→ Smoke check https://api.${DOMAIN}/healthz"
if curl -fsS --max-time 10 "https://api.${DOMAIN}/healthz" >/dev/null; then
  echo "✅ Deploy of $TAG complete."
else
  echo "❌ Smoke check failed — investigate with: docker service ps ${STACK}_api" >&2
  exit 1
fi
