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
COPY package.json package-lock.json ./
# The build stage's node_modules carry the native bindings; reinstalling here with
# --omit=dev would resolve them again and can drift. Size traded for correctness.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
ENV DB_PATH=/data/stake.db
EXPOSE 3000
CMD ["node", "dist/index.js"]
