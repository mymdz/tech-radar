# Everything platform-independent (the page build, the pure-JS dependencies)
# is done once on the build host rather than under emulation.
FROM --platform=${BUILDPLATFORM:-linux/amd64} node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY server ./server
RUN npm test && npm run build && npm prune --omit=dev
# distroless has no shell to mkdir with; the volume takes this owner on first mount.
RUN mkdir -p /icon-cache

# The server runs straight from .ts on Node 24 (type stripping), no compile step.
FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
# The server validates Outline data with the same parser the page uses.
COPY --from=build /app/src/types.ts ./src/types.ts
COPY --from=build /app/src/data/parse.ts ./src/data/parse.ts
# …and resolves icon specs to URLs exactly as the page does.
COPY --from=build /app/src/icons/resolve.ts ./src/icons/resolve.ts
COPY --from=build /app/dist ./web
COPY --from=build --chown=65532:65532 /icon-cache ./icon-cache

ENV NODE_ENV=production STATIC_DIR=/app/web PORT=8080 ICON_CACHE_DIR=/app/icon-cache
EXPOSE 8080
CMD ["server/main.ts"]
