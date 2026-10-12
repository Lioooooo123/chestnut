#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/pi-verify-source.mjs
# Fail closed: image builds must also use rootless Docker.
security="$(docker info --format '{{json .SecurityOptions}}')"
node -e 'const a=JSON.parse(process.argv[1]);if(!Array.isArray(a)||!a.some(x=>/(^|[=,])rootless($|[,=])/.test(x)))throw Error("Rootless Docker required")' "$security"
docker build --file src/sandbox/Dockerfile --tag chestnut-pi:4270522473e6 .
