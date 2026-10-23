---
name: cloudflare-bundler-apps
description: Author Cloudflare Worker Bundler-compatible apps that build and preview correctly inside a space. Use this skill whenever you scaffold, modify, or deploy a project that will be built with `@cloudflare/worker-bundler` (i.e. anything served from `/space/:name/preview/:branch/`). Covers wrangler config, project layout, static asset rules, server entry conventions, npm dependency limits, and the most common cause of blank previews (JSX in browser scripts).
---

This skill teaches how to build apps that deploy cleanly through the space deploy pipeline. Every project committed to a space is built by `@cloudflare/worker-bundler` (`createApp` when there are static assets, `createWorker` when there are none) and served on a Dynamic Worker via `WorkerLoader`. Get the conventions right and the preview "just works". Get them wrong and you get a blank page, a 500, or a `Build failed` error.

## How the pipeline works

When `deploy_space(branch)` is called, the space DO:

1. Reads every file from the branch's working tree (skipping `.git/`).
2. Parses `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` for `main`, `compatibility_date`, `compatibility_flags`, and `[assets]`.
3. If `[assets].directory` is set, files under that directory become static assets served host-side by `handleAssetRequest`. Everything else is built into a Worker via `createApp` (with `server: <main>`).
4. If no assets directory is configured, only `createWorker({ entryPoint: <main> })` is run. The output is loaded as a Dynamic Worker; all requests go to the Worker.
5. Previews are served at `/space/:name/preview/:branch/*`. Responses with `content-type: text/html` are run through `HTMLRewriter`, which prefixes root-relative `src` / `href` / `action` attributes with the preview base path. **JS-side fetches and dynamic imports are NOT rewritten.**

Practical consequences:

- **You can rely on root-relative `src="/foo.js"` and `href="/style.css"` in HTML.** They will be rewritten to the preview path automatically.
- **You cannot rely on root-relative paths inside JS strings**: `fetch("/api/x")`, `new URL("/foo", location.origin)`, dynamic `import("/lib.js")`. These hit the wrong path under the preview prefix. Use relative paths (`./api/x`, `import.meta.url`) or read the base path from `<base href>` / a meta tag injected at build time.
- The `<base href>` tag is also rewritten if present — using it lets all relative URLs resolve against the preview path.

### Repairing an existing preview

When asked to fix a preview, inspect the current files and the actual deploy/preview error first. Preserve the existing app and make the smallest correction; do not replace it with a new scaffold. This pipeline is JavaScript/TypeScript, not Rust: never add `Cargo.toml`, `build.rs`, or `cargo-bundle`. Limit repair attempts and report the last concrete error if the preview still cannot be verified.

## Project layout

A typical full-stack space project:

```
/
├── wrangler.json          # required for non-trivial setups
├── package.json           # npm deps (text-only packages, see limits below)
├── src/
│   └── index.ts           # server entry: export class App extends DurableObject
└── public/                # static assets directory (configurable)
    ├── index.html
    ├── app.js             # compiled, no JSX
    └── styles.css
```

A static-only SPA still needs a `main` module exporting `class App extends DurableObject`; static assets are served before requests reach `App.fetch`.

## Wrangler config

Minimum viable `wrangler.json`:

```json
{
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",
  "assets": {
    "directory": "./public",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "single-page-application"
  }
}
```

`src/index.ts` must export the named `App` Durable Object class shown below. A default Worker export such as `export default { fetch }` is not supported by the preview loader.

Notes:

- `main` is required when there's any server code. The bundler also auto-detects `src/index.ts`, `src/index.js`, `index.ts`, `index.js` if missing.
- `compatibility_date` defaults to `2025-04-01` if omitted. Set it explicitly for newer features.
- Add `"compatibility_flags": ["nodejs_compat"]` only if you actually need Node built-ins.
- `assets.directory` is the **only** way to ship static files. Files outside this directory are bundled into the Worker or ignored — they will **not** be reachable via URL.
- `html_handling: "auto-trailing-slash"` is usually what you want for multi-page sites; SPAs should also set `not_found_handling: "single-page-application"` so deep links return `index.html`.

TOML works too (`wrangler.toml`), but the parser only handles top-level scalar fields plus an `[assets]` table — no inline tables, no env overrides. Prefer JSON.

## Server entry: one Durable Object class named `App`

**Your entire backend is one Durable Object.** Your main module exports
a class named `App` extending `DurableObject`. The platform loads it as
a [Cloudflare Durable Object
Facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
of the host SpaceDO and forwards every non-asset request — including
WebSocket upgrades — to your `App.fetch(request)`.

**Do not `export default { fetch }`.** A default fetch handler will be
ignored. There is no separate worker; the DO is the worker.

```ts
// src/index.ts
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.initDatabase();
  }

  initDatabase() {
    // Schema initialization in the constructor ensures tables exist immediately
    // when the IDE's Database viewer tab inspects SQLite!
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT,
        expires_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        source TEXT DEFAULT 'landing_page',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/leads" && request.method === "POST") {
      const { email, source } = await request.json<{ email: string; source?: string }>();
      this.ctx.storage.sql.exec(`INSERT INTO leads (email, source) VALUES (?, ?)`, email, source || "landing_page");
      return Response.json({ ok: true, message: "Thank you for signing up!" }, { status: 201 });
    }
    if (url.pathname === "/api/leads") {
      const rows = this.ctx.storage.sql
        .exec(`SELECT id, email, source, created_at FROM leads ORDER BY id DESC`)
        .toArray();
      return Response.json(rows);
    }
    return new Response("Not found", { status: 404 });
  }
}
```

Or with Hono inside the DO:

```ts
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export class App extends DurableObject {
  private app = new Hono()
    .get("/api/hello", (c) => c.json({ msg: "hi" }))
    .post("/api/notes", async (c) => {
      const { body } = await c.req.json<{ body: string }>();
      this.ctx.storage.sql.exec(`INSERT INTO notes (body) VALUES (?)`, body);
      return c.json({ ok: true });
    });

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
```

When `[assets]` is configured, static files take priority — your `fetch`
only sees requests that didn't match an asset. For a SPA, put
`index.html` in `public/` and `App.fetch` only handles `/api/*`.

### State and storage

State lives on `this.ctx.storage`. No `env.DB` or D1 binding exists; do not
create D1 migrations, bindings, or a separate table-list endpoint. The app
database viewer reads this same per-(space, branch) SQLite database.

- `this.ctx.storage.sql.exec(sql, ...params)` — full SQLite. Returns a
  cursor with `.toArray()`, `.one()`, `.columnNames`, etc.
- `this.ctx.storage.kv.get(key)` / `.put(key, value)` — simple KV
  backed by SQLite.
- `this.ctx.storage.transactionSync(() => { ... })` — atomic batch
  inside the same DO instance.

```ts
// SQL
this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS counter (n INTEGER)`);
const cur = this.ctx.storage.sql.exec(`SELECT n FROM counter LIMIT 1`).toArray();
const n = (cur[0]?.n as number) ?? 0;

// KV
const last = this.ctx.storage.kv.get<number>("last_seen") ?? 0;
this.ctx.storage.kv.put("last_seen", Date.now());
```

**Use the DO's storage for all persistent state** — users, sessions,
content, settings, anything that should survive a reload. Do not use
`localStorage` or `sessionStorage` for primary data; they are
per-browser, per-origin, and lost on incognito or any other browser.

### Full-Stack Authentication & OAuth Integration

When the user asks to add **authentication, login, or OAuth**:
1. **Always integrate directly into the main application UI** (`public/index.html` or main frontend component). Do NOT create separate documentation (`README.md`, `docker-compose.yml`, `oauth-login.html`, or standalone test suites).
2. **Database schema**: Create `users` and `sessions` tables in SQLite:
   ```sql
   CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, avatar_url TEXT, created_at INTEGER);
   CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
   ```
3. **Backend Auth endpoints in `src/index.ts`**:
   - `POST /api/auth/demo-login`: 1-click test login ("Continue as Demo User" or "Sign in with Google (Demo)"). Returns `{ token, user }`.
   - `GET /api/auth/session`: Validates `Authorization: Bearer <token>` and returns the active user.
   - `POST /api/auth/logout`: Deletes session from SQLite.
   - `GET /api/auth/google`: Full OAuth redirect when `GOOGLE_CLIENT_ID` is present.
4. **Instant working preview**: Always provide the 1-click instant login button in the UI so the user can test authentication immediately in the preview without needing Google Cloud credentials configured beforehand.
5. **Always use relative paths in client JS**: `fetch("./api/auth/session")`, NEVER root-relative `/api/...`.

### WebSockets

The platform forwards `Upgrade: websocket` requests transparently into
`App.fetch`. Use the standard Durable Object hibernation API:

```ts
export class App extends DurableObject {
  async fetch(request: Request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Broadcast to every connected client (chat-style fan-out).
    for (const peer of this.ctx.getWebSockets()) {
      peer.send(typeof message === "string" ? message : new Uint8Array(message));
    }
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    // Cleanup if needed.
  }
}
```

`acceptWebSocket` + `webSocketMessage` is the right pattern for
multi-connection use cases (chat rooms, multiplayer, presence) because
the DO can hibernate between messages without losing connections.

### Per-entity grouping (chat rooms, per-user records)

You get **one App DO per (space, branch)** — a single instance, not a
namespace. Do not call `idFromName` or try to declare a DO binding in
`wrangler.json`; both are rejected. For multi-room / multi-user state,
**partition rows with a column** in the App's SQLite:

```sql
CREATE TABLE messages (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX messages_by_room ON messages (room_id, ts);
```

Then route by `room_id` inside `App.fetch`. SQLite is fast enough that
sharing the same table across rooms is fine for prototyping; if you
later need stronger isolation, attach `room_id` to a tag and use
`acceptWebSocket(ws, [room_id])` so `getWebSockets(room_id)` returns
only that room's sockets.

### What you cannot declare

- **`durable_objects.bindings` in `wrangler.json`.** The platform
  extracts your `App` class automatically. Adding bindings fails the
  deploy with a clear error.
- **`new_sqlite_classes` / migrations.** Same reason. Your App's
  storage is set up by the platform.
- **`d1_databases`, `r2_buckets`, `kv_namespaces`.** Not available.
  Everything goes in `this.ctx.storage`.

## Static asset rules (CRITICAL - READ FIRST)

**THERE IS NO BUILD STEP IN THIS PLATFORM.**
The deployment pipeline (`deploy_space`) does **NOT** run `npm install`, `npm run build`, `vite build`, `esbuild`, or any shell commands. Files in `public/` (or `[assets].directory`) are served **DIRECTLY** to the browser as static assets.

### Forbidden Frontend Patterns:
1. **NEVER ship raw JSX inside `.js` files.** Browsers cannot parse JSX and will crash with `SyntaxError: Unexpected token '<'`.
2. **NEVER use TypeScript (`.ts`, `.tsx`) in `public/`.** Browsers only execute standard JavaScript.
3. **NEVER add `vite`, `esbuild`, `tsup`, `webpack`, or build scripts to `package.json` for frontend code.** They will NOT be executed during deployment.
4. **NEVER create `vite.config.ts`, `webpack.config.js`, or similar frontend bundler configs.**

### Allowed Frontend Patterns:

#### Pattern 1: `htm` with Preact or React (HIGHLY RECOMMENDED)
Gives you standard JSX-like syntax using native JavaScript tagged template literals. Zero build step, runs natively in all modern browsers!

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App</title>
  <link rel="stylesheet" href="./style.css" />
  <script type="importmap">
  {
    "imports": {
      "preact": "https://esm.sh/preact@10.25.4",
      "preact/hooks": "https://esm.sh/preact@10.25.4/hooks",
      "htm/preact": "https://esm.sh/htm@3.1.1/preact"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

```javascript
// public/app.js
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";

function App() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("./api/items")
      .then((res) => res.json())
      .then((items) => {
        setData(items);
        setLoading(false);
      });
  }, []);

  return html`
    <div class="container">
      <header class="header">
        <h1>Dashboard</h1>
      </header>
      <main>
        ${loading ? html`<p>Loading...</p>` : html`
          <ul>
            ${data.map((item) => html`<li key=${item.id}>${item.name}</li>`)}
          </ul>
        `}
      </main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
```

#### Pattern 2: Modern Vanilla JavaScript & Web Components
Standard ES modules with template literals, reactive event listeners, and direct DOM manipulation. Clean, fast, and completely immune to bundler/JSX issues.

#### Pattern 3: `React.createElement` (Plain JavaScript)
If using React without `htm`, write pure `React.createElement`:
```javascript
import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

function App() {
  return React.createElement("div", { className: "landing" },
    React.createElement("h1", null, "Hello World")
  );
}
createRoot(document.getElementById("root")).render(React.createElement(App));
```

### Agent Invariants & Problem Solving Rules:
1. **Rule 1: Stop Thrashing**: If `get_browser_console_logs` shows `Unexpected token '<'` or any error twice, **STOP**. Do NOT attempt to configure build tools (Vite/esbuild). Switch immediately to Pattern 1 (`htm/preact`) or Pattern 2 (Vanilla JS).
2. **Rule 2: Cleanup Dead Artifacts**: If you attempted a configuration that failed (e.g. created `vite.config.ts` or added unused dependencies in `package.json`), **DELETE** them before reporting completion.
3. **Rule 3: Real Verification Only**: Never end a turn with "Next steps: verify it works". You must call `deploy_space`, run `get_browser_console_logs`, confirm 0 console errors, and report the actual outcome.

### Symptom-to-fix index

| Console error | Cause | Fix |
| --- | --- | --- |
| `Uncaught SyntaxError: Unexpected token '<'` (inside `<script type="module">`) | JSX shipped raw to the browser without a build step | Switch to `htm/preact` (tagged template literals) or vanilla JS immediately. Never try to add Vite or esbuild! |
| `Uncaught TypeError: Failed to resolve module specifier "..."` | Missing importmap entry | Add the CDN URL (e.g. `https://esm.sh/...`) to `<script type="importmap">` in `index.html` before the module script |
| `TypeError: Cannot read properties of null (reading 'useContext')` | Dual-React (two copies loaded) | Append `?external=react,react-dom` to every esm.sh URL with React as a peer dep |

### Other asset gotchas

- **Binary assets are not extracted from npm packages.** Fonts, images, and `.wasm` shipped via npm tarballs will be missing. Put binaries directly in `public/` instead.
- **Paths in JS need care under preview**: prefer `import.meta.url`, relative paths, or a runtime base detected from `document.baseURI`. Don't hard-code `/api/...` in client code; use `./api/...` or read a base from a `<meta>` tag.
- **Trailing slashes matter** for `auto-trailing-slash` mode: `/about` serves `about.html`, `/about/` serves `about/index.html`. Pick one shape and link consistently.
- **No CSS preprocessors at runtime** — ship `.css`, not `.scss`. Compile first if you need Sass.
- **Importmaps work** since they're inline JSON. Use them to avoid bundling React/etc. for prototypes — but watch the dual-React trap below.

### The dual-React trap (the #1 cause of "blank page + `useContext` is null`)

`esm.sh` bundles a package's peer dependencies *into the package itself* unless you tell it otherwise. So this importmap looks correct but ships **two copies of React** — one for your app, another nested inside `framer-motion`:

```html
<!-- BROKEN: framer-motion has its own React inside, hooks crash with `Cannot read properties of null (reading 'useContext')` -->
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.2.0",
    "react-dom": "https://esm.sh/react-dom@18.2.0/client",
    "framer-motion": "https://esm.sh/framer-motion@11"
  }
}
</script>
```

The symptom is exactly: blank background + console errors like

```
TypeError: Cannot read properties of null (reading 'useContext')
  at u (SwitchLayoutGroupContext.mjs:1:1)
```

because the nested React instance has no provider in the tree.

**Fix: append `?external=react,react-dom` (and any other shared peers) to every esm.sh URL that has React as a peer dep.** Pin the exact same React version everywhere too.

```html
<!-- CORRECT: one React shared across the whole importmap -->
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "framer-motion": "https://esm.sh/framer-motion@11?external=react,react-dom",
    "lucide-react": "https://esm.sh/lucide-react@0.400.0?external=react,react-dom"
  }
}
</script>
```

Apply `?external=...` to **every** React-consuming dep (UI libraries, icon sets, animation libs, headless components). Same rule for `vue`, `solid-js`, etc. if you swap the framework.

If a project needs more than two or three of these packages, stop using the importmap path — switch to option 1 (pre-compile with Vite/esbuild) so the bundler can dedupe React for you.

## npm dependencies

The bundler installs deps from npm at build time. Limits to respect:

- **Flat node_modules.** No two versions of the same package can coexist — peer-dep conflicts will pick one and break the other. Keep dep graphs shallow.
- **Text-only files** are extracted from tarballs. `.js`, `.ts`, `.json`, `.css`, `.md` work. `.wasm`, `.node`, native binaries, fonts, images do not.
- **No PAX tar headers** — packages whose internal paths exceed 100 chars may have those files silently dropped. Avoid deeply-nested monorepo packages.
- **No build scripts run** — `postinstall`, `prepare`, etc. are ignored. Packages that compile native code or run codegen at install time will not work.
- **`cloudflare:*` imports are always external** and resolved by the runtime (`cloudflare:workers`, etc.). Don't add them to `package.json`.

Safe and well-tested deps: `hono`, `zod`, `itty-router`, `nanoid`, `valibot`, `@hono/zod-validator`. Avoid anything that needs node-native modules unless you set `compatibility_flags: ["nodejs_compat"]` and the package is pure JS under that flag.

## Project shapes

| Project shape                       | What you need                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Pure static site (HTML+JS+CSS only) | `wrangler.json` with `[assets]`, files in `public/`, and a minimal `App` class for the required `main` entry. |
| SPA + API                           | `[assets]` for the SPA, `main` exporting `class App extends DurableObject`             |
| API only (JSON, no frontend)        | `main` exporting `class App extends DurableObject`, no `[assets]`                      |
| Realtime (WebSocket / multiplayer)  | Same as SPA + API; `App.fetch` upgrades to WebSocket and uses `ctx.acceptWebSocket`    |

## Pre-flight checklist before `deploy_space`

Run through every item — most "preview is broken" reports trace back to one of these.

- `wrangler.json` exists at repo root with `main` exporting `class App extends DurableObject` and (if static assets exist) `[assets].directory`.
- Every browser-loaded `.js` / `.mjs` / `<script type="module">` is **plain JS, no JSX**, or wrapped with `@babel/standalone` + `type="text/babel"`.
- If you use React via importmap (Babel-standalone or pre-compiled with the automatic JSX runtime), the importmap maps **all** of `react`, `react/jsx-runtime`, `react-dom`, and `react-dom/client` — same version on every entry. Missing `react/jsx-runtime` produces `Failed to resolve module specifier "react/jsx-runtime"` and a blank page.
- The `<script type="importmap">` tag appears **before** any `<script type="module">` (or `type="text/babel" data-type="module"`) that depends on the mapped specifiers.
- Static files live under the configured `assets.directory` (default suggestion: `public/`).
- HTML uses root-relative paths (`/foo.js`) — they get rewritten. JS uses relative paths (`./foo`).
- No binary assets are imported from npm packages. Binaries live in `public/`.
- `package.json` deps are pure-JS, no native modules, no install scripts.
- SPA routing? Set `not_found_handling: "single-page-application"`.
- Server entry exports `class App extends DurableObject` from your `main` module (no `export default { fetch }`).
- No `durable_objects` / `d1_databases` / `kv_namespaces` / `r2_buckets` blocks in `wrangler.json`.
- `compatibility_date` is set if you use APIs newer than the default.

If any of these are off, fix them in the working tree, commit, and redeploy. The preview will pick up the new build on the next `deploy_space` call (the dynamic worker is keyed by commit hash, so old builds are not reused).

## Minimal end-to-end example

A working SPA with a tiny API:

```
wrangler.json
package.json
src/index.ts
public/index.html
public/app.js
public/style.css
```

`wrangler.json`:

```json
{
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",
  "assets": {
    "directory": "./public",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "single-page-application"
  }
}
```

`package.json`:

```json
{ "name": "demo", "type": "module", "dependencies": { "hono": "^4.6.0" } }
```

`src/index.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export class App extends DurableObject {
  private app = new Hono()
    .get("/api/time", (c) => c.json({ now: new Date().toISOString() }))
    .post("/api/visit", async (c) => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER)`
      );
      this.ctx.storage.sql.exec(`INSERT INTO visits (ts) VALUES (?)`, Date.now());
      const cnt = this.ctx.storage.sql
        .exec(`SELECT COUNT(*) AS c FROM visits`)
        .one().c as number;
      return c.json({ count: cnt });
    });

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
```

`public/index.html`:

```html
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="root">Loading…</div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

`public/app.js`:

```js
const res = await fetch("./api/time");
const data = await res.json();
document.getElementById("root").textContent = data.now;

// Increment + display visit counter (server state lives in App.ctx.storage.sql)
const v = await fetch("./api/visit", { method: "POST" }).then((r) => r.json());
document.getElementById("root").textContent += `  ·  visits: ${v.count}`;
```

Note `./api/time` (relative) in JS, `/style.css` (root-relative) in HTML. The HTML href is rewritten by the preview; the JS fetch resolves against the document's base URL.

Commit this, call `deploy_space("main")`, and the preview at `/space/<name>/preview/main/` will render the timestamp and an incrementing visit counter persisted in the App DO's SQLite.

## Curated Starter Templates
When scaffolding a new application, identify which pattern fits the user request and start from its proven structure:

### 1. Modern Business Landing Page
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, created_at INTEGER)`);
  ```
- **Frontend (`public/index.html` + `public/app.js`)**:
  - Hero with punchy headline, value proposition, and primary action button.
  - Interactive product/menu grid with high-resolution imagery and badge filters.
  - Testimonial slider / customer reviews with star ratings.
  - Contact or reservation form submitting to `./api/leads`.

### 2. Todo & Task Manager with Database and Auth
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, status TEXT, priority TEXT, due_date TEXT, created_at INTEGER);
  `);
  ```
- **Endpoints**: `POST /api/auth/demo-login`, `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`.
- **Frontend**: Filter tabs (All, Active, Completed), priority badges (Low, Medium, High), inline checkbox toggles, instant demo login.

### 3. Full-Stack Blog with Admin Editor
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, title TEXT, slug TEXT UNIQUE, summary TEXT, content TEXT, author TEXT, published_at INTEGER);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, article_id TEXT, author TEXT, body TEXT, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/articles`, `GET /api/articles/:slug`, `POST /api/articles`, `POST /api/articles/:id/comments`.
- **Frontend**: Reader article list with search, clean typography reading view, comment submission form, and "Admin Mode" modal with markdown editor.

### 4. SaaS Analytics Dashboard
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS metrics (date TEXT PRIMARY KEY, revenue REAL, active_users INTEGER, signups INTEGER);
    CREATE TABLE IF NOT EXISTS activity_log (id TEXT PRIMARY KEY, event TEXT, user TEXT, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/metrics`, `GET /api/activity`.
- **Frontend**: Key metric stat cards with trend percentages (+12% vs last week), interactive SVG bar/line charts, and recent activity log table.

### 5. E-Commerce Storefront with Cart Drawer
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT, description TEXT, price REAL, category TEXT, image_url TEXT, in_stock INTEGER);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, customer_email TEXT, items_json TEXT, total REAL, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/products`, `POST /api/checkout`.
- **Frontend**: Search & category pills, product cards with "Add to Cart", animated slide-over cart drawer with quantity increments and order total.

### 6. Appointment & Service Booking App
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT, duration_mins INTEGER, price REAL);
    CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, client_name TEXT, client_email TEXT, service_id TEXT, scheduled_time TEXT, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/services`, `GET /api/booked-slots`, `POST /api/appointments`.
- **Frontend**: Multi-step booking wizard: 1) Select Service, 2) Select Date & Time Slot, 3) Enter Client Details, 4) Confirmation Ticket.

### 7. Developer Portfolio & Showcase
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT, desc TEXT, tags TEXT, github_url TEXT, demo_url TEXT);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, name TEXT, email TEXT, message TEXT, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/projects`, `POST /api/messages`.
- **Frontend**: Dark mode hero banner, tech stack pill tags, project showcase cards with external link buttons, and working contact form.

### 8. Timed Trivia Quiz with Leaderboard
- **Schema & Backend (`src/index.ts`)**:
  ```ts
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, question TEXT, option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT, correct_opt TEXT, explanation TEXT);
    CREATE TABLE IF NOT EXISTS leaderboard (id TEXT PRIMARY KEY, player_name TEXT, score INTEGER, total INTEGER, time_seconds INTEGER, created_at INTEGER);
  `);
  ```
- **Endpoints**: `GET /api/questions`, `POST /api/leaderboard`, `GET /api/leaderboard`.
- **Frontend**: 15-second countdown timer per question, instant color-coded feedback (green/red) with explanations, final score card, and top-10 leaderboard.

