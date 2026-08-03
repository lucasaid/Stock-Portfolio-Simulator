# Debian trixie (glibc 2.41), NOT bookworm (2.36): better-sqlite3's prebuilt
# binary is linked against GLIBC_2.38 and dies with ERR_DLOPEN_FAILED on bookworm.
FROM node:22-trixie-slim AS build
WORKDIR /app
# Toolchain for any native module that has no usable prebuild and must compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `scripts/onecli-claude-wrapper.sh` (set as the Agent SDK's pathToClaudeCodeExecutable
# in runner-options.ts) shells out to this onecli binary to wrap the SDK's bundled
# `claude` executable specifically — see that script's header comment for why only
# the claude binary itself needs wrapping, not the whole backend process.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL onecli.sh/cli/install | sh
ENV PATH="/root/.local/bin:${PATH}"
COPY package.json package-lock.json ./
# The build stage's node_modules carry the native bindings; reinstalling here with
# --omit=dev would resolve them again and can drift. Size traded for correctness.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/onecli-claude-wrapper.sh ./scripts/onecli-claude-wrapper.sh
RUN chmod +x scripts/onecli-claude-wrapper.sh && mkdir -p /data
ENV DB_PATH=/data/stake.db
EXPOSE 3000
CMD ["node", "dist/index.js"]
