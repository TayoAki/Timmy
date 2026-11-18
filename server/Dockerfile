# Timmy's API, which also serves the app built in live mode. Build context: the repository root.
FROM node:22-slim AS build
# No install-time analytics from dependencies (Scarf, which CopilotKit's packages include).
ENV SCARF_ANALYTICS=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public public
COPY src src
COPY server server
# The app, built to talk to this API on the same origin.
RUN VITE_TIMMY_LIVE=1 npx vite build --outDir /app/web
RUN cd server && node build.mjs && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
# CopilotKit's runtime sends no usage telemetry (see src/lib/no-telemetry.ts).
ENV COPILOTKIT_TELEMETRY_DISABLED=true DO_NOT_TRACK=1
WORKDIR /app/server
COPY --from=build /app/server/node_modules node_modules
COPY --from=build /app/server/dist dist
COPY --from=build /app/server/migrations migrations
COPY --from=build /app/server/package.json package.json
COPY --from=build /app/web /app/web
ENV WEB_DIST=/app/web MIGRATIONS_DIR=/app/server/migrations
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
