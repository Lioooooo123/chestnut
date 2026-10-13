FROM node:24-bookworm-slim AS build
WORKDIR /opt/pi
COPY vendor/pi/package.json vendor/pi/package-lock.json ./
COPY vendor/pi ./
COPY vendor/pi-model-catalog.json /opt/pi-model-catalog.json
RUN node -e "const fs=require('fs'),c=require('crypto');const pin=JSON.parse(fs.readFileSync('nix/model-catalog.json')).revision;if('sha256-'+c.createHash('sha256').update(fs.readFileSync('/opt/pi-model-catalog.json')).digest('hex')!==pin)throw Error('Model catalog pin mismatch')"
RUN npm ci --ignore-scripts --no-audit --no-fund && node packages/ai/scripts/hydrate-model-catalog.ts /opt/pi-model-catalog.json && npm run build:offline
# Retain one coherent workspace tree. No registry Pi package replaces source.
RUN node -e "const fs=require('fs');for(const d of fs.readdirSync('packages')){const p='packages/'+d+'/package.json';if(!fs.existsSync(p))continue;const n=JSON.parse(fs.readFileSync(p)).name;if(n?.startsWith('@earendil-works/')){const r=fs.realpathSync('node_modules/'+n);if(!r.startsWith('/opt/pi/packages/'))throw Error('mixed Pi dependency: '+n)}}"
FROM node:24-bookworm-slim
ARG WITH_DESKTOP=0
RUN if [ "$WITH_DESKTOP" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends xvfb openbox chromium xdotool imagemagick procps fonts-dejavu-core && rm -rf /var/lib/apt/lists/* && test "$(id -u node)" = 1000; fi
LABEL org.chestnut.desktop="${WITH_DESKTOP}"
LABEL org.chestnut.desktop.browser="chromium"
LABEL org.chestnut.pi.commit="4270522473e677ddba7b093caa0064a3df51d459"
LABEL org.chestnut.persistent.profile="experimental-v1"
COPY --from=build /opt/pi /opt/pi
COPY src/sandbox/container-entry.mjs /opt/chestnut/container-entry.mjs
COPY src/sandbox/persistent-supervisor.mjs /opt/chestnut/persistent-supervisor.mjs
COPY src/sandbox/persistent-task-entry.mjs /opt/chestnut/persistent-task-entry.mjs
COPY src/memory/pi-extension.mjs /opt/chestnut/memory-extension.mjs
COPY src/environments/pi-extension.mjs /opt/chestnut/environment-extension.mjs
COPY src/environments/chromium-policies.json /etc/chromium/policies/managed/chestnut.json
WORKDIR /workspace
ENV HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/pi-agent PI_OFFLINE=1 PI_NO_UPDATE_CHECK=1
# UID 0 is namespaced by verified rootless Docker, never host root.
USER 0:0
ENTRYPOINT ["node", "/opt/chestnut/container-entry.mjs"]
