# syntax=docker/dockerfile:1
# Locke image. Locke is an Ilven integration in its own repo: it uses Ilven's shared libraries (@ilven/common on the
# server, @ilven/web-auth in the browser) from the Ilven repo, passed as the named build context "ilven" (compose.yaml).
FROM node:22-alpine AS build
WORKDIR /src
COPY --from=ilven packages/web-auth ilven/packages/web-auth
COPY --from=ilven packages/common ilven/packages/common
COPY package.json package-lock.json locke/
WORKDIR /src/locke
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm test && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/locke/dist/ ./
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
