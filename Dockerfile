# Multi-stage: node:24 (full) has the toolchain to compile native modules
# (better-sqlite3); node:24-slim is the lean runtime.
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/core-server/package.json ./apps/core-server/
COPY apps/core-server/tsconfig.json ./apps/core-server/
COPY apps/core-server/src ./apps/core-server/src

RUN npm ci --workspace=apps/core-server --workspace=packages/core --workspace=packages/types --workspace=packages/api --workspace=packages/protocol

RUN npm run build --workspace=packages/types --workspace=packages/protocol --workspace=packages/api --workspace=packages/core --workspace=apps/core-server

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# node_modules (with compiled native modules) + built output from the build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
EXPOSE 4100
CMD ["node", "apps/core-server/dist/index.js"]
