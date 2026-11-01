# carrefour-it-mcp — the MCP server with its own Chromium and a remote screen.
#
#   docker build -t carrefour-it-mcp .
#   docker run --rm carrefour-it-mcp scripts/cloudflare-probe.mjs        # can this host reach carrefour.it?
#   docker compose up -d                                                 # the HTTP server (see docker-compose.yml)
#   docker run --rm -i -e MCP_TRANSPORT=stdio -v carrefour-data:/data carrefour-it-mcp   # stdio, for a local client
#
# Sessions, browser profiles, OAuth tokens and logs live in /data: mount a
# volume there and keep it private (it holds carrefour.it and Google sessions).

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CARREFOUR_DATA_DIR=/data \
    TZ=Europe/Rome \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    NOVNC_DIR=/usr/share/novnc \
    VNC_PORT=5900 \
    CARREFOUR_LOGIN_NO_SANDBOX=1

WORKDIR /app

# The remote screen: virtual display, window manager, VNC server, noVNC client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc fluxbox novnc fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so code changes do not reinstall them. Scripts are skipped:
# the postinstall would download Chromium into the user's cache, which the
# step below does into a shared path instead, with its system libraries. On
# amd64, Google Chrome is added for the login windows: Cloudflare's captcha is
# slow to validate in Playwright's Chrome for Testing.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts \
 && npx playwright install --with-deps chromium \
 && if [ "$(dpkg --print-architecture)" = "amd64" ]; then npx playwright install chrome; fi \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
COPY scripts ./scripts
COPY docker ./docker
RUN npx tsc && npm prune --omit=dev

# Run as an unprivileged user; Chromium and Chrome run without their sandbox
# (CARREFOUR_LOGIN_NO_SANDBOX), so no extra capabilities are needed.
RUN useradd --create-home --uid 10001 carrefour \
 && mkdir -p /data && chown -R carrefour:carrefour /data /app
USER carrefour
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=1m --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["dist/index.js"]
