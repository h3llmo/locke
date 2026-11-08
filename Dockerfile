# syntax=docker/dockerfile:1
# Locke image. Locke is an Ilven integration in its own repo: it uses Ilven's shared browser auth
# (@ilven/web-auth) from the Ilven repo, passed as the named build context "ilven" (see compose.yaml).
FROM node:22-alpine AS build
WORKDIR /src
COPY --from=ilven packages/web-auth ilven/packages/web-auth
COPY package.json package-lock.json locke/
WORKDIR /src/locke
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/locke/dist/ ./
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
