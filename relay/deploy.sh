#!/usr/bin/env bash
#
# Deploy the Instant relay to Cloud Run.
#
#   relay/deploy.sh staging      # telekey-relay-staging: test credits, testers only
#   relay/deploy.sh production   # telekey-relay-production
#
# Tests and bundles first, then builds the image with Cloud Build from this
# directory. The OpenAI key and the staging testers list come from
# functions/.env, the same file the Functions API is deployed from, so there
# is one place to change them. They are passed as plain env vars through a
# temporary YAML file (an @ or a comma in a value breaks --set-env-vars), and
# never printed.
set -euo pipefail

STAGE="${1:-}"
if [[ "${STAGE}" != "staging" && "${STAGE}" != "production" ]]; then
  echo "usage: relay/deploy.sh staging|production" >&2
  exit 2
fi

PROJECT="telekey-app"
REGION="us-east1"
SERVICE="telekey-relay-${STAGE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_SOURCE="${ROOT}/functions/.env"

cd "${ROOT}/relay"
[[ -d node_modules ]] || npm ci
npm test
npm run build

ENV_YAML="$(mktemp)"
trap 'rm -f "${ENV_YAML}"' EXIT

python3 - "${ENV_SOURCE}" "${STAGE}" "${ENV_YAML}" <<'PY'
import json, sys

source, stage, target = sys.argv[1:4]
values = {}
with open(source) as handle:
    for line in handle:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value

wanted = {"TELEKEY_STAGE": stage, "OPENAI_API_KEY": values.get("OPENAI_API_KEY", "")}
if stage == "staging":
    wanted["STAGING_ALLOWED_EMAILS"] = values.get("STAGING_ALLOWED_EMAILS", "")
if not wanted["OPENAI_API_KEY"]:
    sys.exit(f"OPENAI_API_KEY is missing from {source}")

with open(target, "w") as handle:
    for key, value in wanted.items():
        # A JSON string is a valid YAML scalar, whatever it contains.
        handle.write(f"{key}: {json.dumps(value)}\n")
PY

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --source . \
  --env-vars-file "${ENV_YAML}" \
  --allow-unauthenticated \
  --timeout 900 \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 10 \
  --memory 512Mi \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"
echo
echo "Deployed ${SERVICE}: ${URL}"
echo "The app connects to ${URL/https:/wss:}/v1/realtime?intent=transcription"
