# Glama starts the server from this image and checks that it answers introspection.
# Nothing here needs a wallet: discovery is free, and a key would be the user's to supply.
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile resolved at the workspace root so the build is reproducible.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY integrations/mcp-bridge/package.json integrations/mcp-bridge/
RUN corepack enable && pnpm install --filter @fatstack/mcp-bridge... --frozen-lockfile

COPY tsconfig.base.json ./
COPY integrations/mcp-bridge integrations/mcp-bridge
RUN pnpm --filter @fatstack/mcp-bridge build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/integrations/mcp-bridge/node_modules /app/node_modules
COPY --from=build /app/integrations/mcp-bridge/dist /app/dist

# stdio transport: the protocol is stdin/stdout, so nothing may be logged to stdout.
ENTRYPOINT ["node", "/app/dist/index.js"]
