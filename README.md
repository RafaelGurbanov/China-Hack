# CampusBridge AI

A full-stack fintech prototype that helps international students manage money across borders: budgeting in two currencies, planning tuition payments, comparing cross-border transfers and getting help from a financial assistant that acts only with their confirmation.

> **Prototype.** Exchange rates are illustrative fixed values (not live). Transfer routes are fictional archetypes ("Demo …"), not real providers. Simulated transfers never move money. CampusBridge is not a bank, payment institution or credit provider, and nothing here is financial advice.

## Topic

**International Track, Topic C: Cross-border & Student Finance Assistant.**

## The problem

Students who study abroad live between two financial systems. Support from family arrives in one currency (for example Azerbaijani manat), while rent, food and tuition are paid in another (for example euros). In practice this means:

- **No single picture of their money.** Balances, spending and savings sit in different currencies, so it is hard to know what is actually available this month.
- **Hidden transfer costs.** The fee is visible, but the exchange-rate margin is not. Two routes that look similar can deliver noticeably different amounts.
- **Tuition deadlines arrive unplanned.** Large semester payments need months of saving, yet students rarely know how much to put aside each month or whether they are on track.
- **Little financial guidance.** Students new to a country often do not know how budgeting, transfers or credit history work there.

## Our solution

CampusBridge AI brings these pieces into one workspace:

- **Overview:** one balance across all currency wallets, spending against budget, tuition progress, upcoming bills and an end-of-month forecast.
- **Money Atlas:** an interactive map of money corridors (Baku to Berlin, London, Istanbul, Beijing and New York) showing what arrives through each simulated route.
- **Budgets and tuition goals:** multi-currency expenses, category limits, bills, and a savings plan that tells you what to save each month and when you will finish.
- **Transfers:** a transparent comparison of four simulated routes with the full calculation (fee, conversion, rate margin), so students see why one route delivers more.
- **Bridge Intelligence:** a financial assistant that interprets a task, shows its calculation, and proposes an action that runs in a sandbox only after the student confirms. Every step is recorded in an audit trail.

The demo scenario is a **fictional** Azerbaijani student in Germany: family support arrives in AZN, costs are paid in EUR.

## Technologies

| Layer | What we used |
| --- | --- |
| Frontend | React 19, Vite, Tailwind CSS 4, React Router, Lucide icons, custom SVG visualisations (Money Atlas, charts) |
| Backend | Node.js 22+, Express 5, REST API |
| Database | SQLite (built-in `node:sqlite`) |
| Security | scrypt password hashing, HTTP-only session cookies, CSRF protection, rate limiting, server-side validation, audit log |
| Assistant | Rules-based task engine (interpret → validate → calculate → propose → confirm → execute → record), designed so an AI model can be connected later |
| Design | Fraunces, Geist and JetBrains Mono typefaces; an editorial ivory, ink, forest and lime palette |
| Testing | Vitest (unit and API tests), Playwright (browser walkthrough at six screen sizes), ESLint |

## Team

| Name | Role | Focus |
| --- | --- | --- |
| Rafael Gurbanov | Full-stack developer | Frontend and backend development |
| Ayan Mahmudova | UX/UI designer | User experience, visual identity and interface design |
| Nabiyeva Gulustan | Full-stack developer | Frontend and backend development |
| Elgun Shukurov | AI/ML engineer | Bridge Intelligence assistant and its AI integration path |

## What works

| Area | What you can do |
| --- | --- |
| **Accounts** | Register, sign in, sign out. Passwords are hashed with scrypt; sessions are opaque tokens in HTTP-only cookies; every workspace route requires a session. |
| **Overview** | Oversized available balance with its change since last month end and a six-month trend; tuition savings kept visibly apart (progress arc); quick actions (add expense, add savings, compare transfers, ask Bridge Intelligence); Money Atlas strip; spending by category against budget and last month; recent activity; path to tuition; upcoming obligations and month-end estimate. All computed from stored data. |
| **Money Atlas** | The signature view: an abstract SVG projection with curved corridors from your home city to Berlin, London, Istanbul, Beijing and New York. Pick a destination on the map or in the accessible table to see the illustrative rate, best simulated route, fee, range and your own simulation history, then simulate or compare. |
| **Budgets** | Add, edit and delete income and expenses in AZN, EUR, USD, GBP, TRY or CNY; category limits with utilisation; filters (search, type, category, currency, month); recurring and one-off bills you can mark as paid. |
| **Tuition goals** | Target, currency, deadline, starting savings and planned monthly saving; remaining amount, required monthly saving, projected finish date, status; a chart of your plan against the pace needed; contributions with a before/after review and confirmation. |
| **Transfers** | Write the transfer as a sentence ("Send 500 AZN to EUR"), rank four simulated routes by amount received, speed, fee or balance, pick one to see the full calculation (fee, conversion, mid rate, margin), and simulate it after an explicit acknowledgement. |
| **Bridge Intelligence** | Rules-based (no AI model connected) task workspace: a task input, suggested tasks, a task log showing interpretation, validation and calculation, proposed actions you confirm or cancel, and a sandbox audit trail. Supported tasks include comparing and simulating transfers, saving plans, forecasts, spending explanations, adding expenses, savings contributions and credit-building basics. |
| **Activity** | Audit log grouped by day: sign-ins, edits, deletions, proposals, confirmations, rejections, expiries, validation failures and refusals, with filters. |
| **Settings** | Home and study currency, monthly support and its arrival day, account details, sample data and clearing records. |

### The sandbox workflow (assistant and pages share it)

```
request ─▶ interpret ─▶ validate ─▶ calculate ─▶ propose (pending action, 15-min expiry)
                                                       │
                              user confirms ◀──────────┘ (or cancels → nothing changes)
                                    │
             server re-validates (ownership, amounts, wallet balance) ─▶ execute in one DB transaction
                                    │
                         record audit events ─▶ show result
```

Example: *"Compare sending 500 AZN to my EUR budget and show how much I would receive."* The assistant validates the amount and currencies, quotes all four routes, shows the fee/rate breakdown, proposes simulating the best one, and records `SIM-…` only after you confirm.

## Design

An editorial identity built on six colours: warm ivory `#F5F2EA` and ink `#171916` for the workspace, deep forest `#153E35` for immersive sections, acid lime `#D7FF64` as a highlighter for key figures and the selected route, stone `#D9D5CA` for quiet surfaces and signal coral `#FF725E` for shortfalls. Fraunces sets headlines and large figures, Geist the interface, JetBrains Mono rates, IDs and timestamps. A dashed line always means "illustrative or simulated". Motion is limited to the balance reveal, route drawing and pulses, chart drawing and progress changes, and it is switched off when the system asks for reduced motion.

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module, so there is nothing native to compile). Node 24 LTS is recommended.
- npm 10+.

## Setup

```bash
npm install
cp .env.example .env        # optional; defaults work for local use (Windows: copy .env.example .env)
```

### Development (two processes, hot reload)

```bash
npm run dev
```

- API: http://127.0.0.1:8787 (Express)
- Web: http://localhost:5173 (Vite, proxies `/api` to the API)

### Production-style (one process)

```bash
npm run build     # builds the React app into dist/
npm start         # Express serves the API and dist/ on http://127.0.0.1:8787
```

Behind HTTPS, set `NODE_ENV=production` (or `COOKIE_SECURE=true`) so the session cookie is marked `Secure`.

### Demo account

On startup the server creates a **fictional** demo account (unless `SEED_DEMO=false`):

- Email: `demo@campusbridge.test`
- Password: `CampusBridge-demo-2026`

New accounts can start empty or with the same fictional sample data. `npm run seed:demo` resets the demo account's data. Disable the demo account for anything beyond a demonstration.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on a network) |
| `DATABASE_PATH` | `data/campusbridge.db` | SQLite file, created automatically |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `COOKIE_SECURE` | `true` in production | Send the session cookie only over HTTPS |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Extra browser origins allowed to call the API (comma-separated) |
| `SEED_DEMO` | `true` | Create the fictional demo account |

No secrets are needed: there are no third-party API keys, and nothing secret is shipped to the browser.

## Database

SQLite via `node:sqlite`. The schema in `server/db.js` is applied automatically on start. Tables: `users`, `sessions`, `profiles`, `budgets`, `transactions` (the ledger; wallet balances are derived from it), `savings_goals`, `obligations`, `transfer_simulations`, `pending_actions`, `assistant_messages` and `audit_events`. Each financial table carries `user_id`, and every query filters by the id taken from the verified session.

To start over, stop the server and delete the database file (`data/campusbridge.db`, plus its `-wal`/`-shm` files).

## Tests

```bash
npm test          # 35 unit + API tests (Vitest, in-memory database)
npm run lint
npm run build && npm start   # then, in another terminal:
npm run e2e -- http://127.0.0.1:8787 e2e-shots 1440 900   # browser walkthrough (needs Playwright + Chromium)
```

The API tests cover hashing, cookies, rate limiting, logout invalidation, CSRF, server-side validation, cross-user isolation, locked audit records, confirmation, rejection and expiry of actions, the assistant's end-to-end task, clarifying questions, and refusals. The browser walkthrough (55 checks) has been run at 1440, 1280, 1024, 768, 390 and 320 px. Restart the server between runs: five failed sign-ins per IP in 15 minutes trigger the rate limiter.

## Project structure

```
shared/finance.js     All financial logic: rates, quotes, budgets, savings, forecast, validation, redaction (used by server and browser)
server/index.js       Entry point: config, demo seeding, start
server/app.js         Express app: security headers, CSRF guard, REST routes, error handling
server/auth.js        scrypt hashing, sessions, cookies, CSRF, sign-in rate limiter
server/db.js          SQLite schema, mappers, audit helper, fictional sample data
server/services.js    Workspace snapshot and the sandbox action workflow
server/assistant.js   Rules-based assistant (guard → interpret → validate → compute → propose)
src/App.jsx           React app: UI kit, layout, auth screens and all pages
src/index.css         Tailwind design tokens
tests/                Vitest unit and API tests
e2e/walkthrough.mjs   Playwright walkthrough
```

### Main API endpoints

`POST /api/auth/register|login|logout`, `GET /api/auth/me`, `GET /api/workspace`, `PUT /api/profile`, `PUT /api/budgets`, `POST|PUT|DELETE /api/transactions[/:id]`, `PUT /api/savings-goal`, `POST|DELETE /api/obligations[/:id]`, `POST /api/obligations/:id/pay`, `POST /api/transfers/quote`, `GET|POST /api/actions`, `POST /api/actions/:id/confirm|reject`, `GET|POST|DELETE /api/assistant/messages`, `GET /api/activity`, `POST /api/workspace/sample|reset`.

State-changing requests must carry the header `X-CampusBridge-Request: 1` (the frontend does this); cross-site requests are rejected.

## Security notes

- Passwords: scrypt (N=16384, r=8, p=1) with a per-user salt; constant-time comparison; same response and similar timing for unknown emails.
- Sessions: 256-bit random tokens; only their SHA-256 hash is stored; `HttpOnly`, `SameSite=Lax`, `Secure` in production; deleted on logout.
- CSRF: custom header plus origin check on every state-changing request.
- Rate limiting: 5 failed sign-ins per IP and per email per 15 minutes.
- Authorisation: user id comes only from the session; other users' records return 404.
- Validation: every amount, currency, date, category and text field is validated on the server; card numbers, IBANs and credentials are refused in text fields and redacted from assistant messages before storage.
- Headers: CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`; JSON bodies capped at 20 KB.
- Audit: no passwords, tokens or message text are written to the audit log. Simulated transfers and savings contributions cannot be edited or deleted.

## Adding a real AI model later

`server/assistant.js` exposes a provider with one method, `interpret(text, context) → { intent, params }`. A language-model provider can replace `rulesProvider` there. Validation, proposal, confirmation, execution and auditing stay on the server and do not change, so a model can never execute anything on its own. Update `ASSISTANT_MODE` so the interface states accurately what is connected.

## Known limitations

- Rates are a fixed sample table and routes are fictional; no live provider is integrated.
- The rules-based assistant understands a limited set of phrasings.
- No email delivery, so there is no password reset or email verification; accounts are local to the server's database.
- The rate limiter is in memory (it resets on restart and is per process).
- SQLite suits a single server; a multi-instance deployment would need a shared database such as PostgreSQL.
