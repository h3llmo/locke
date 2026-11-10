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
# Image previews (thumbnails, display sizes): sharp and its native libvips, outside the bundle.
COPY --from=build /src/locke/node_modules/sharp ./node_modules/sharp
COPY --from=build /src/locke/node_modules/@img ./node_modules/@img
COPY --from=build /src/locke/node_modules/semver ./node_modules/semver
COPY --from=build /src/locke/node_modules/detect-libc ./node_modules/detect-libc
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
