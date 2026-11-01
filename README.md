# Carrefour Italia MCP — grocery shopping for your AI agent

**MCP server for Carrefour Italia (carrefour.it, Spesa Online).** Let Claude,
Cursor, or any Model Context Protocol client search the Italian grocery
catalogue, find the stores that serve your CAP, book a delivery or pickup slot
and manage your cart — on your own Carrefour account.

A port of [maximeallanic/CarrefourDriveMCP](https://github.com/maximeallanic/CarrefourDriveMCP)
(carrefour.fr) to carrefour.it. The two sites share nothing but the brand:
carrefour.it is a Salesforce Commerce Cloud storefront, so every endpoint, the
login and the response parsing were rewritten from real carrefour.it traffic.

**32 tools.** 14 carrefour.it endpoints described as JSON and run by a generic
executor, 14 tools written in code for the checkout, shopping lists, bulk cart
operations and past orders, and 4 session-management tools.

```
"Quanto costa il latte senza lattosio?"         → search_products
"Which Carrefour stores deliver to 20121?"      → find_stores
"Book Saturday morning for home delivery."      → get_delivery_timeslots + reserve_delivery_timeslot
"Add two packs of Barilla spaghetti n.5."       → search_products + add_to_cart
"What's in my cart, and am I over the minimum?" → get_cart
"A che punto è il mio ordine? Stampami lo scontrino." → get_order_status + get_order_receipt
"Riordina la spesa della settimana scorsa."      → reorder_order
```

- **Standalone** — no external gateway, no API key. Clone, build, run.
- **Cloudflare-proof** — every call is issued from a real Chromium page, because
  nothing else gets a `200`.
- **Compact answers** — the storefront answers in HTML fragments (a product grid
  is ~275 kB for 25 products); the server extracts the data the site's own
  JavaScript reads and hands the model a few kB of JSON.

---

## Table of contents

- [Install](#install)
- [Connect it to your agent](#connect-it-to-your-agent)
- [Log in](#log-in)
- [Tool reference](#tool-reference)
- [What is verified](#what-is-verified)
- [How authentication works](#how-authentication-works)
- [How the executor works](#how-the-executor-works)
- [Configuration](#configuration)
- [Verify the install](#verify-the-install)
- [FAQ](#faq)

---

## Install

Node.js **20+** is the only prerequisite (native `fetch`, `FormData`, `node:test`).

```sh
npx -y github:gliderking84-byte/carrefourdrivemcp-ita
```

That single command fetches, builds and starts the server on stdio — the first
run also downloads the Chromium it uses as HTTP transport. Most of the time you
put it in your MCP client config instead and let the client run it.

Your session, browser profile and logs live in `~/.carrefour-it-mcp`
(`$XDG_DATA_HOME/carrefour-it-mcp` when set). Override with `CARREFOUR_DATA_DIR`.

<details>
<summary>From source instead</summary>

```sh
git clone https://github.com/gliderking84-byte/carrefourdrivemcp-ita.git
cd carrefourdrivemcp-ita
npm install     # builds, and downloads the Chromium transport
node dist/index.js
```

A source checkout keeps its data in the repo's own `data/` directory.

</details>

## Connect it to your agent

### Claude Code

```sh
claude mcp add carrefour-it -- npx -y github:gliderking84-byte/carrefourdrivemcp-ita
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`, Linux: `~/.config/Claude/`):

```json
{
  "mcpServers": {
    "carrefour-it": {
      "command": "npx",
      "args": ["-y", "github:gliderking84-byte/carrefourdrivemcp-ita"]
    }
  }
}
```

> On Windows, use `"command": "cmd"` with
> `"args": ["/c", "npx", "-y", "github:gliderking84-byte/carrefourdrivemcp-ita"]`.

### Cursor, Windsurf, Zed, VS Code and other MCP clients

Any client that speaks MCP over stdio takes the same `command` / `args` pair.
Installed from source? Use `{"command": "node", "args": ["/absolute/path/to/dist/index.js"]}`.

## Log in

carrefour.it gates its login form with a **Cloudflare Turnstile** captcha, so
signing in is interactive:

1. Ask your agent to run **`carrefour_browser_login`**.
2. A browser window opens on the private-customer login page
   (`carrefour.it/login?type=b2c`). Sign in yourself. The window is your own
   **Chrome** (or Edge, Brave, Chromium — the first one installed), on a
   dedicated profile kept in `<data>/login-profile`: Cloudflare's captcha is slow
   and keeps expiring in Playwright's "Chrome for Testing", which is only the
   fallback. Point `CARREFOUR_LOGIN_BROWSER` at another executable to choose.
3. **Don't close the window** — the server notices it left the login page, reads
   the session cookies from memory, checks that carrefour.it sees you as signed
   in, and closes it.
4. The tool call itself returns after at most ~45 s (`CARREFOUR_LOGIN_WAIT_MS`),
   sending progress notifications meanwhile, because MCP clients time out long
   before a human is through a captcha (MCP Inspector: 60 s). If you are still
   typing, the login simply finishes in the background: run
   `carrefour_session_status` with `verify: true` afterwards to confirm.

The session is then kept alive while the server runs. If it idles out,
carrefour.it silently turns it into a guest session; every 🔒 tool checks for
that first and asks you to sign in again.

| Session tool | What it does |
| --- | --- |
| `carrefour_browser_login` | open a window to sign in (`method: "google"` opens "Accedi con Google") |
| `carrefour_session_status` | stored cookies, browser profile; `verify: true` asks the site whether you are signed in |
| `carrefour_set_cookies` | import cookies manually (header, JSON map, or JSON array) |
| `carrefour_clear_session` | wipe the local session |

### Staying signed in with Google

carrefour.it also signs you in with **"Accedi con Google"**, which has no captcha
of its own. Once you are signed in to Google in the login profile, the server can
sign in to carrefour.it again **by itself** whenever the session expires:

1. Run `carrefour_browser_login` with `method: "google"` and sign in to Google in
   the window (once, password and 2-step verification included).
2. Set `CARREFOUR_GOOGLE_RELOGIN=1`.

From then on, when a tool finds no session or a guest one, the server opens the
Google button's URL (`…/Login-OAuthLogin?oauthProvider=Google…`) in the login
profile. Google answers without a password, the window lands back on
carrefour.it, and the cookies are lifted as after a manual login — then the call
goes on. This is the same un-automated window as the manual login, only started
by the server; nothing is typed and no password is stored.

- If Google wants you again (expired Google session, new-device check), the
  attempt fails, the tool says so, and you sign in once by hand. A failed attempt
  is not retried for 10 minutes.
- `CARREFOUR_GOOGLE_RELOGIN_HEADLESS=1` runs the attempt without a visible window
  (for a server without a desktop). Google may treat headless browsers with more
  suspicion: if attempts fail, run it with a window (e.g. under Xvfb).
- **The login profile now holds a Google session**, which reaches the whole
  Google account (Gmail, Drive…). Keep the data directory private, on an
  encrypted disk, and consider a Google account used only for the shopping. The
  Google account must be the one linked to your carrefour.it account, or
  Carrefour may create a new, empty one.

## Tool reference

All carrefour.it controllers live under
`/on/demandware.store/Sites-carrefour-IT-Site/it_IT/` (written `…/` below).

### Catalogue *(no account needed)*

| Tool | Endpoint | Required params |
| --- | --- | --- |
| `search_products` | GET …/FactFinder-Search | `q` |
| `browse_category` | GET …/Search-UpdateGrid | `cgid` |
| `search_suggestions` | GET …/SearchRouter-Suggestions | `q` |
| `get_product` | GET …/Tile-Show | `ean` |

Products come back as `{ean, name, brand, price, list_price, discount,
unit_price, size, category_path, tags, quantity_in_cart, url}`; grids add
`next_start` for the next page.

### Stores & delivery

| Tool | Endpoint | Required params |
| --- | --- | --- |
| `find_stores` | GET …/Store-Search | `cap`, `city` |
| `get_delivery_selection` | GET …/Store-ShowTimeslotReserved | — |
| `get_delivery_timeslots` 🔒 | GET …/TimeSlotApi-GetTimeSlots | `storeId`, `shipmentId`, `cap`, `city` |
| `reserve_delivery_timeslot` 🔒✍️ | POST …/TimeSlotApi-ReserveTimeSlot | `shippingMethodId`, `timeslotId`, `timeslotStart`, `timeslotEnd`, `timeslotEco`, `storeId`, `cap`, `city` |

Shipping methods: `delivery` (Consegna a casa), `pickup_in_store` (Ritiro in
negozio), `drive` (Ritiro al Drive). A reservation lasts 45 minutes and also
selects the store the cart is priced for. **Reserve a slot before adding to the
cart**: in a session with no delivery method chosen — a fresh login window has
none — `add_to_cart` is refused with `NO_SHIPPING_METHOD_SELECTED`.

### Cart

| Tool | Endpoint | Required params |
| --- | --- | --- |
| `get_cart` 🔒 | GET …/Minicart-Show | — |
| `add_to_cart` 🔒✍️ | POST /cart/add-product | `ean` (`quantity` defaults to 1) |
| `update_cart_item_quantity` 🔒✍️ | GET /cart/updatequantity | `ean`, `decrease` |

🔒 needs a signed-in session, checked before the call · ✍️ changes your account:
the server fetches a CSRF token (`…/CSRF-Generate`) right before sending it.

### Checkout

| Tool | What it does |
| --- | --- |
| `get_addresses` 🔒 | saved delivery addresses (`…/Account-AddressBook`) |
| `apply_coupon` 🔒✍️ | discount code (`…/CheckoutServices-AddCoupon`) |
| `prepare_checkout` 🔒✍️ | reserves the slot, opens `/checkout/begin`, submits the address (`/checkout/shipping-submit`), validates it against the delivery CAP and sets the slot (`…/Checkout-UpdateTimeslot`); returns items, delivery cost and total. **Orders nothing.** Home delivery, or pickup in store (`shippingMethodId: pickup_in_store`, with the store's `cap` and `city` from `find_stores`; no address is submitted). |
| `place_order` 🔒✍️ | **creates the order** (`/checkout/payment`) and opens the payment page in your browser |

Ordering is a two-step, human-approved flow:

1. `prepare_checkout` returns the summary; the agent shows it to you.
2. Only after you say yes, `place_order` with `confirm: true`. It refuses without
   it, without a `prepare_checkout` from the last 30 minutes, and never places
   the same prepared checkout twice.
3. **You pay.** The order's payment page (Market Pay, then PayPal with its
   hCaptcha, or your card's 3-D Secure) opens in your browser, on the login
   profile that holds your carrefour.it session. Strong customer authentication
   is a human step by design; the server never sees payment credentials.

Only PayPal (`MP_PAYPAL`) is supported so far: it is the only method captured.
Drive is not supported yet.

### Shopping lists & bulk cart

| Tool | Endpoint |
| --- | --- |
| `get_shopping_lists` 🔒 | GET /account/wishlist (page, parsed) |
| `get_shopping_list` 🔒 | GET /wishlist?id=… (page, parsed) |
| `create_shopping_list` 🔒 | POST …/Wishlist-NewList |
| `add_to_shopping_list` 🔒 | POST …/Wishlist-AddPrd |
| `remove_from_shopping_list` 🔒 | POST …/Wishlist-RemovePrd |
| `add_shopping_list_to_cart` 🔒✍️ | the list's products in one POST /cart/add-product (`pidsObj`) |
| `add_products_to_cart` 🔒✍️ | several products and quantities in one POST /cart/add-product |
| `empty_cart` 🔒✍️ | POST …/Cart-EmptyCart (needs `confirm: true`), then checks the cart is empty |

### Orders

Every order tool takes an optional `order_number` (from `get_orders`); without
it, the most recent order is used. Customer name, phone, e-mail, loyalty card and
street address present in the history are never returned.

| Tool | Endpoint |
| --- | --- |
| `get_orders` 🔒 | GET …/Order-HistoryOrders: orders, totals, payment, per-shipment method, timeslot, status, available documents |
| `get_order_status` 🔒 | the same, reduced to one order's status (verifica ordine) |
| `get_order_details` 🔒 | the history entry plus the products from GET /account/order?orderID=… (page, parsed) |
| `get_order_receipt` 🔒 | the receipt (PDF on Carrefour's Salesforce file server) and invoice links, to open and print |
| `reorder_order` 🔒✍️ | GET the shipment's `reorderUrl` (…/Order-Reorder): its products go back into the cart; needs a booked slot |

## What is verified

The first 27 tools were tested end to end through the MCP server on a real
carrefour.it account (MCP Inspector, October 2026): catalogue, stores and
timeslots, cart, shopping lists, empty cart, and the checkout for home delivery
and pickup in store, with `place_order` up to the payment page opening in the
user's browser. The order tools (November 2026) follow captured traffic for the
history, receipt and reorder; the order detail page was not captured, so its
product parser relies on the site's usual product markup. Every endpoint was first observed in real browser traffic, and
the parsers are unit-tested on trimmed copies of the real answers.

## How authentication works

carrefour.it is a Salesforce Commerce Cloud (SFRA) storefront. The whole
session — guest or signed in — lives in SFCC cookies on `www.carrefour.it`.
There is no separate identity provider and no refresh token.

- **Login** posts to `…/Account-Login` with a Turnstile token only a human in a
  real browser can produce. The login window is therefore a plain Chromium with
  a debug port open but **nothing attached** until you are done: the server
  polls the tab list over plain HTTP (`/json/list`, no CDP domain enabled, so no
  automation trace), and attaches only once the window has left `/login`. The
  session cookies are session cookies Chromium never writes to disk, so they are
  read from memory before the window closes.
- **Signed-in check** — SFCC never answers `401`: an expired session is just a
  guest one. `…/Store-SelectionBar` carries `data-option-user-logged`, which the
  server reads before every authenticated call (cached for 5 minutes) and on
  `carrefour_session_status verify=true`.
- **CSRF** — every write needs a token from `POST …/CSRF-Generate`. Tools marked
  `"csrf": true` get one fetched right before the call, injected as the reserved
  `{"$param": "csrf_token"}`. Tokens are redacted from logs and stripped from
  responses.
- **Keep-alive** — while the browser runs, `…/Store-ShowTimeslotReserved` is
  read every 20 minutes so the session does not idle out.

## How the executor works

```
tools/*.json ──► loader (validation) ──► params (JSON Schema ➜ zod) ──► MCP tools/list
                                     └─► resolve ($param ➜ URL/query/headers/body)
                                              └─► http.service (browser fetch + rate limit)
                                                       └─► extract (HTML/JSON ➜ compact JSON)
```

Every file in `tools/` is self-describing:

```jsonc
{
  "name": "add_to_cart",
  "parameters": { "type": "object", "properties": { "ean": { … }, "quantity": { "type": "number", "default": 1 } }, "required": ["ean"] },
  "request": {
    "method": "POST",
    "url": "https://www.carrefour.it/cart/add-product",
    "headers": { "x-requested-with": "XMLHttpRequest", … },
    "body": { "pid": { "$param": "ean" }, "quantity": { "$param": "quantity" }, "csrf_token": { "$param": "csrf_token" }, … },
    "content_type": "multipart/form-data"
  },
  "requires_auth": true,
  "csrf": true,
  "response": { "extract": "json", "pick": ["error", "message", "quantityTotal", "totalPrice"] }
}
```

The engine (`src/spec/`):

- **substitutes** `{"$param": "name"}` nodes in `headers`, `query` and `body`,
  preserving types, and fills parameter `default`s;
- **drops** placeholders with no argument, so optional params vanish from the
  request instead of being sent as `null`;
- **encodes the body** per `content_type`: JSON, `x-www-form-urlencoded` or
  `multipart/form-data`;
- **extracts** the response (`src/spec/extract.ts`): `product_grid`, `cart`,
  `suggestions`, `stores`, `timeslots`, or `json` (drops the SFCC envelope —
  `action`, `nonce`, `queryString`, … — optionally keeps only `pick`ed keys, and
  flattens fields that contain markup to text).

Adding an endpoint = dropping a new JSON file into `tools/`, plus an extractor
if the site answers in HTML.

## Remote access: HTTP mode, Docker and the desk

For a Claude custom connector (web, desktop, mobile), a PWA or the Claude API,
the server runs over **Streamable HTTP** with its own OAuth, usually in Docker on
an always-on machine, published through a tunnel.

### 1. Check that the machine can reach carrefour.it

carrefour.it sits behind Cloudflare: a home connection is known to work, a
datacenter IP may be challenged. Test a candidate machine first:

```sh
git clone https://github.com/gliderking84-byte/carrefourdrivemcp-ita.git && cd carrefourdrivemcp-ita
docker build -t carrefour-it-mcp .
docker run --rm carrefour-it-mcp scripts/cloudflare-probe.mjs
```

`scripts/cloudflare-probe.mjs` (also `npm run probe` without Docker) drives the
server's own transport against public pages only, with a throwaway profile and
no account, and prints `VERDICT: PASS` (exit 0) or `VERDICT: BLOCKED` (exit 1).
It also prints the machine's public IP, looked up through api.ipify.org.

### 2. Run it

```sh
cp .env.example .env    # set PUBLIC_URL, MCP_OWNER_PASSPHRASE, TUNNEL_TOKEN (and MCP_API_TOKEN if needed)
docker compose up -d
```

`docker-compose.yml` runs the server and a Cloudflare Tunnel (`cloudflared`): in
Cloudflare Zero Trust → Networks → Tunnels, route your hostname (e.g.
`mcp.example.com`) to `http://carrefour:3000`. No port is opened on the router.

Without Docker: `MCP_TRANSPORT=http node dist/index.js` (or `--http`) with the
same variables.

| Endpoint | What it is |
| --- | --- |
| `/mcp` | the MCP endpoint — needs a bearer token |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1 (dynamic client registration, PKCE) |
| `/oauth/consent` | where you approve a client with `MCP_OWNER_PASSPHRASE` |
| `/desk` | the server's screen in your browser (noVNC), behind the same passphrase |
| `/health` | liveness, no auth |

#### Or with Tailscale Funnel (no domain needed)

On a home machine, `docker-compose.tailscale.yml` publishes the server at a
stable `https://<name>.<tailnet>.ts.net` address through
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel), with no domain and no
port opened on the router. Tailscale runs in its own container; the server
shares its network and listens on 127.0.0.1 only.

1. In the [Tailscale admin console](https://login.tailscale.com/admin):
   - **DNS**: turn on MagicDNS and HTTPS Certificates, and note your tailnet name
     (`something.ts.net`);
   - **Access controls**: make sure the policy lets this machine use Funnel
     (a `nodeAttrs` entry with `"attr": ["funnel"]`);
   - **Settings → Keys**: generate an auth key.
2. In `.env`: `TS_AUTHKEY`, `TS_HOSTNAME` (e.g. `carrefour-mcp`),
   `PUBLIC_URL=https://carrefour-mcp.<tailnet>.ts.net`, `MCP_OWNER_PASSPHRASE`.
3. `docker compose -f docker-compose.tailscale.yml up -d`.
4. Once the machine shows up in the admin console, **disable key expiry** for it,
   so it does not drop off the tailnet after a few months.

The serve configuration is `docker/tailscale-serve.json` (HTTPS on 443, proxied
to the server, Funnel on).

### 3. Connect Claude

claude.ai → Settings → Connectors → **Add custom connector** →
`https://mcp.example.com/mcp`. Claude registers itself, opens the consent page,
and you approve with the passphrase. Access tokens last an hour and refresh
tokens 30 days (rotated on use), stored hashed in `<data>/oauth.json`. A PWA
backend or the Claude API's MCP connector can instead send
`Authorization: Bearer <MCP_API_TOKEN>`.

### 4. Sign in to carrefour.it from anywhere: the desk

In the container the login windows open on a virtual screen (Xvfb). Open
`https://mcp.example.com/desk`, enter the passphrase, and you see and drive that
screen from any device: run `carrefour_browser_login` (with `method: "google"`
for Google) and sign in there. With `CARREFOUR_GOOGLE_RELOGIN=1` you do this
once; later re-logins happen by themselves. The payment page of `place_order`
opens on the same screen, and its link is also returned.

The VNC server listens on 127.0.0.1 inside the container only; the desk's
passphrase-protected WebSocket proxy is the only way in. Wrong passphrases are
limited to 10 per 15 minutes per address, on the desk and the consent page.

### Security notes

- `MCP_OWNER_PASSPHRASE` (12+ characters) guards your carrefour.it account and,
  with Google re-login, a Google session: use a long, unique one.
- Keep the `/data` volume private: it holds sessions, browser profiles and tokens.
- This is a **single-account** server: whoever passes the consent page acts on
  the one carrefour.it account it is signed in to. Multi-user support is not
  built yet.

## Configuration

See `.env.example`. Main variables:

| Variable | Default | Role |
| --- | --- | --- |
| `CARREFOUR_COOKIES` | — | session cookies (header, JSON map or JSON array) |
| `CARREFOUR_COOKIE_FILE` | — | path to a JSON cookie export |
| `CARREFOUR_DATA_DIR` | `~/.carrefour-it-mcp` (repo `data/` from source) | root of everything written below |
| `CARREFOUR_SESSION_FILE` | `<data>/sessions/cookies.json` | persisted cookie jar |
| `CARREFOUR_BROWSER_PROFILE` | `<data>/browser-profile` | persistent Chromium profile |
| `CARREFOUR_KEEPALIVE_MINUTES` | `20` | session keep-alive period; `0` disables |
| `CARREFOUR_LOGIN_WAIT_MS` | `45000` | how long `carrefour_browser_login` waits before returning |
| `CARREFOUR_LOGIN_BROWSER` | first installed Chrome / Edge / Brave / Chromium | browser executable for the login window |
| `CARREFOUR_GOOGLE_RELOGIN` | off | `1`: sign in again through "Accedi con Google" when the session is lost |
| `CARREFOUR_GOOGLE_RELOGIN_HEADLESS` | off | `1`: run that re-login without a visible window |
| `CARREFOUR_GOOGLE_RELOGIN_TIMEOUT_MS` | `60000` | how long one Google re-login may take |
| `CARREFOUR_NAV_TIMEOUT_MS` | `60000` | browser navigation timeout |
| `CARREFOUR_USER_AGENT` | stock Chrome UA | UA of the transport browser |
| `CARREFOUR_TOOLS_DIR` | `<project>/tools` | JSON tool definitions directory |
| `CARREFOUR_MAX_RESPONSE_CHARS` | `60000` | truncation of large responses |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | `10` / `60000` | rate-limit window |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | `100` / `500` | jitter between requests |
| `LOG_LEVEL`, `CARREFOUR_LOG_DIR` | `info`, `<data>` | winston logs (files + stderr, **never stdout**) |

## Verify the install

From a source checkout:

```sh
npm run build     # tsc
npm test          # build + unit tests (node:test)
npm run smoke     # build + real MCP stdio handshake + tools/list
npm run verify    # all three
```

Tests cover request building for every tool, CSRF and session rules, the cookie
jar, and every response extractor (on trimmed copies of real carrefour.it
markup). The smoke test boots the server, performs the JSON-RPC handshake and
lists the tools.

> Network calls to carrefour.it are **not** tested automatically — they need a
> real account and a session.

## FAQ

**Do I need an API key?** No. Carrefour has no public API; this server drives the
same private endpoints the website uses, with your own session.

**Is my password stored?** No. You type it in a browser window; only cookies are
persisted, in `<data>/sessions/cookies.json` with `0600` permissions.

**Can it place an order?** Yes, after you approve the summary — and you always
pay yourself, in your browser. Only PayPal is supported so far.

**I captured a HAR to add an endpoint — anything to watch out for?** A HAR of a
login contains your password in clear text, and HARs carry your address and
session tokens. Never commit one (`*.har` is gitignored) and delete it once done.

## Disclaimer

Unofficial project, not affiliated with, endorsed by, or supported by Carrefour.
For personal and educational use on your own account. Respect Carrefour's terms
of service and rate-limit yourself accordingly.

## License

MIT — see [LICENSE](LICENSE). Based on CarrefourDriveMCP by Maxime Allanic.
