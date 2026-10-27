# Carrefour Italia MCP — grocery shopping for your AI agent

**MCP server for Carrefour Italia (carrefour.it, Spesa Online).** Let Claude,
Cursor, or any Model Context Protocol client search the Italian grocery
catalogue, find the stores that serve your CAP, book a delivery or pickup slot
and manage your cart — on your own Carrefour account.

A port of [maximeallanic/CarrefourDriveMCP](https://github.com/maximeallanic/CarrefourDriveMCP)
(carrefour.fr) to carrefour.it. The two sites share nothing but the brand:
carrefour.it is a Salesforce Commerce Cloud storefront, so every endpoint, the
login and the response parsing were rewritten from real carrefour.it traffic.

**27 tools.** 14 carrefour.it endpoints described as JSON and run by a generic
executor, 9 tools written in code for the checkout, shopping lists and bulk cart
operations, and 4 session-management tools.

```
"Quanto costa il latte senza lattosio?"         → search_products
"Which Carrefour stores deliver to 20121?"      → find_stores
"Book Saturday morning for home delivery."      → get_delivery_timeslots + reserve_delivery_timeslot
"Add two packs of Barilla spaghetti n.5."       → search_products + add_to_cart
"What's in my cart, and am I over the minimum?" → get_cart
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
| `carrefour_browser_login` | open a window to sign in |
| `carrefour_session_status` | stored cookies, browser profile; `verify: true` asks the site whether you are signed in |
| `carrefour_set_cookies` | import cookies manually (header, JSON map, or JSON array) |
| `carrefour_clear_session` | wipe the local session |

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

## What is verified

All 27 tools were tested end to end through the MCP server on a real
carrefour.it account (MCP Inspector, October 2026): catalogue, stores and
timeslots, cart, shopping lists, empty cart, and the checkout for home delivery
and pickup in store, with `place_order` up to the payment page opening in the
user's browser. Every endpoint was first observed in real browser traffic, and
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
