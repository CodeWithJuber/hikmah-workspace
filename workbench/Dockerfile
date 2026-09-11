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
COPY --from=build --chown=node:node /workbench/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
# The workspace volume is mounted over this; the directory exists so that a run
# without a volume still starts somewhere the shell user can write.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
EXPOSE 3001
# /health needs the shared token, so the healthcheck reads it from the same
# environment the service does rather than opening an unauthenticated path.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HIKMAH_WORKBENCH_PORT||3001)+'/health',{headers:{authorization:'Bearer '+process.env.HIKMAH_WORKBENCH_TOKEN}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
