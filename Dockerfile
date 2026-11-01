# carrefour-it-mcp — the MCP server with its own Chromium.
#
#   docker build -t carrefour-it-mcp .
#   docker run --rm carrefour-it-mcp scripts/cloudflare-probe.mjs   # can this host reach carrefour.it?
#   docker run --rm -i -v carrefour-data:/data carrefour-it-mcp     # the MCP server (stdio)
#
# Sessions, browser profiles and logs live in /data: mount a volume there, and
# keep it private (it holds carrefour.it and, with Google re-login, Google sessions).

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CARREFOUR_DATA_DIR=/data \
    TZ=Europe/Rome

WORKDIR /app

# Dependencies first, so code changes do not reinstall them. Scripts are skipped:
# the postinstall would download Chromium into the user's cache, which the
# step below does into a shared path instead, with its system libraries.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
COPY scripts ./scripts
RUN npx tsc && npm prune --omit=dev

# Run as an unprivileged user; Playwright launches Chromium without its sandbox,
# so no extra capabilities are needed.
RUN useradd --create-home --uid 10001 carrefour \
 && mkdir -p /data && chown -R carrefour:carrefour /data /app
USER carrefour
VOLUME ["/data"]

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
