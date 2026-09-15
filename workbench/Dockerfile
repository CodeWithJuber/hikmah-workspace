# The workbench runs the commands the assistant is allowed to run. It is its own
# image because the app image is read-only, installs with --ignore-scripts and
# drops every capability: a pty binding and an interactive shell cannot live
# there. Keeping them apart also means a command that misbehaves cannot reach
# the app's data volume or its secrets.
FROM node:24-bookworm-slim AS build
WORKDIR /workbench
# node-pty is a native addon. The prebuild covers Linux, but the toolchain stays
# here so a platform without one still builds instead of failing at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /workbench
ENV NODE_ENV=production \
    HIKMAH_WORKBENCH_PORT=3001 \
    HIKMAH_WORKSPACE_DIR=/workspace
ARG HIKMAH_BUILD_ID=local
LABEL org.opencontainers.image.title="Hikmah Workbench" \
      org.opencontainers.image.revision=$HIKMAH_BUILD_ID
# The shell the owner gets, plus what the assistant's commands normally reach
# for. git and curl are here because a coding session without them is not one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git curl ca-certificates procps less python3 \
  && rm -rf /var/lib/apt/lists/*
# root:root, deliberately. The assistant's commands used to run as the same uid
# that owned this source, so a command could overwrite src/server.ts and own the
# service on the next restart. No slot user can write any of it now.
COPY --from=build --chown=root:root /workbench/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
RUN chmod -R a-w /workbench/src /workbench/package.json

# One Unix user per account: hk01..hk32, uid and gid 3001..3032. Pre-created in
# the image rather than grown on demand, because creating users at run time
# needs a writable /etc, and a service that can rewrite /etc/passwd is a larger
# thing than one that cannot. No login shell and no supplementary groups: these
# exist to own files and run commands, not to be logged into.
RUN for i in $(seq 1 32); do \
      n=$(printf 'hk%02d' "$i"); \
      id=$((3000 + i)); \
      groupadd -g "$id" "$n"; \
      useradd -M -N -s /usr/sbin/nologin -u "$id" -g "$id" "$n"; \
    done

# Every command the assistant runs goes through this. Root-owned and
# world-executable, so a slot user can run it and none can edit it.
COPY --chown=root:root bin/hikmah-run /usr/local/bin/hikmah-run
COPY --chown=root:root bin/hikmah-shell /usr/local/bin/hikmah-shell
RUN chmod 0755 /usr/local/bin/hikmah-run /usr/local/bin/hikmah-shell

# The workspace volume is mounted over this. 0755 root-owned: the supervisor
# lists it and creates slot directories under u/, and each slot directory is
# 0700 owned by its own uid (src/slots.ts).
RUN mkdir -p /workspace/u && chown -R root:root /workspace && chmod 0755 /workspace /workspace/u
# No USER: the supervisor starts as root so it can drop to a slot uid before
# exec. It holds only SETUID, SETGID and CHOWN (deploy/compose.yml) — notably
# not DAC_OVERRIDE, so it cannot read a slot user's files either.
EXPOSE 3001
# /health needs the shared token, so the healthcheck reads it from the same
# environment the service does rather than opening an unauthenticated path.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HIKMAH_WORKBENCH_PORT||3001)+'/health',{headers:{authorization:'Bearer '+process.env.HIKMAH_WORKBENCH_TOKEN}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
