FROM node:24-slim AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/core-server/package.json ./apps/core-server/
COPY apps/core-server/tsconfig.json ./apps/core-server/
COPY apps/core-server/src ./apps/core-server/src

RUN npm ci --workspace=apps/core-server --workspace=packages/core --workspace=packages/types --workspace=packages/api --workspace=packages/protocol

RUN npm run build --workspace=packages/types --workspace=packages/protocol --workspace=packages/api --workspace=packages/core --workspace=apps/core-server

EXPOSE 4100
CMD ["node", "apps/core-server/dist/index.js"]
