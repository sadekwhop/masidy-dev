# Masidy-Dev Project Audit

**Date:** Current HEAD `6254491` (fix: remove CLOUDFLARE_AI_GATEWAY_ROUTE='yes')  
**Scope:** Full platform — worker, React SPA, payment system, database, auth, MCP, rate limiting

---

## Executive Summary

The core platform (routing, auth, agent system, database) is **solid and well-structured**. The payment system is **half-built**: the deposit side (MetaMask → USDC → verify → credit balance) is complete and wired end-to-end, but the **spending side is entirely disconnected** — `deductCredits` exists in `PaymentService` but is never called by any agent, rate-limiter, or usage checker. A user can pay in; nothing is deducted when they use the platform. There are also 6 live TypeScript errors in `usage-limit-checker.tsx`, a debug `console.log` that fires on every authenticated request, a missing migration 0008 in the sequence, and `viem` is not a direct `package.json` dependency.

---

## 1. Core Functionality

**Status: Working ✅**

- `worker/index.ts` handles domain routing correctly: main domain → Hono app, subdomain → sandbox/dispatch.
- `worker/app.ts` wires CORS, CSRF, rate limiting, and auth middleware in the right order. All `/api/*` routes default to `ownerOnly`; public routes explicitly override with `setAuthLevel(AuthConfig.public)`.
- `worker/api/routes/index.ts` registers all route groups including the new `setupPaymentRoutes`. No gaps found in route registration.
- The MCP route `/mcp` is correctly bypassed from CSRF enforcement (`app.ts` line ~43).

**Minor: debug console.log on every request**

`worker/middleware/auth/routeAuth.ts:95` contains:
```ts
console.log('requirement', requirement, 'for user', user);
```
This fires on every call through `routeAuthChecks` — i.e., every authenticated API route — and dumps auth state to logs in production. Should be removed.

---

## 2. Authentication

**Status: Working ✅**

- Auth middleware (`worker/middleware/auth/routeAuth.ts`) is wired through `adaptController` → `enforceAuthRequirement` on every controller call.
- Public routes (`/api/auth/*`, `/api/status`, `/api/capabilities`, `/api/apps/public`, `/api/apps/:id`, `/api/screenshots`, `/api/sentry/tunnel`) are correctly marked `AuthConfig.public`.
- Ticket-based auth (for WebSocket upgrades) is implemented and falls through to JWT auth if no ticket.
- OAuth routes (`/oauth/`, `/auth/callback`) are excluded from secure headers to avoid immutable-header issues on redirects.
- No obviously unprotected routes that should be protected were found.

---

## 3. Payment System — CRITICAL GAP

### Deposit side (user pays in): ✅ Complete

| Component | File | Status |
|---|---|---|
| DB tables | `worker/database/schema.ts` (`userCredits`, `userPayments`, `usageTransactions`) | ✅ |
| Migration | `migrations/0009_certain_true_believers.sql` | ✅ Applied remotely |
| PaymentService | `worker/database/services/PaymentService.ts` | ✅ Full CRUD |
| On-chain verifier | `worker/services/payments/PaymentVerificationService.ts` | ✅ via viem on Base mainnet |
| API routes | `worker/api/routes/paymentRoutes.ts` (5 endpoints) | ✅ |
| Controller | `worker/api/controllers/payments/controller.ts` | ✅ |
| Frontend billing | `src/components/billing-section.tsx` | ✅ MetaMask + manual tx |
| Frontend usage | `src/components/usage-dashboard.tsx` | ✅ |
| Settings page | `src/routes/settings/index.tsx` — `<BillingSection />` | ✅ |
| Profile page | `src/routes/profile.tsx` — `<UsageDashboard />` | ✅ |
| API client | `src/lib/api-client.ts` — 4 payment methods | ✅ |
| Query keys | `src/lib/query-keys.ts` — `account.payments.*` | ✅ |
| API types | `src/api-types.ts` — exports from `payments/types` | ✅ |

### Spend/deduction side: ❌ NOT WIRED

`PaymentService.deductCredits()` (`worker/database/services/PaymentService.ts:117`) exists but is **never called anywhere**. A search of the entire `worker/` tree for `deductCredits` returns only its definition and the controller import — no agent, rate-limiter, or middleware calls it.

The `usageTransactions` table will always be empty. The "Usage Dashboard" shows zero transactions for every user, even ones who have been using the platform heavily. The `totalUsed` column in `userCredits` will never update.

The `usage-dashboard.tsx` `ACTION_LABELS` defines labels for `think_agent`, `codegen`, `app_create`, `mcp_tool`, `deployment` — but none of these actions are ever deducted from the balance.

**The billing model (2× markup on actual cost) is designed but inoperative.** Users who add credits are not charged for usage.

### viem as an undeclared direct dependency

`worker/services/payments/PaymentVerificationService.ts` imports from `viem` and `viem/chains`. `viem` is installed (`node_modules/viem` exists) but only as a transitive peer dependency of `mppx` (declared `"viem": ">=2.57.1"`), **not as a direct dependency in `package.json`**. This works today because mppx pins viem 2.57.7, but a `bun install --frozen-lockfile` or mppx version bump could silently drop it.

### MetaMask timing risk

`billing-section.tsx:147` waits a hardcoded 8 seconds after `eth_sendTransaction` before calling verify. On a congested chain, 8 seconds may not be enough for block confirmation, causing a verification failure and requiring the user to re-paste the tx hash manually.

---

## 4. MCP Payment Gate

**Status: Working ✅ (with a config prerequisite)**

- `worker/api/routes/mcpRoutes.ts` uses `mppx/hono` to charge `$0.02 USDC` per POST tool call via `Mppx.charge()`.
- The middleware correctly returns 402 with a payment challenge when unpaid, and calls `next()` when verified.
- GET and DELETE (session setup/teardown) are correctly left unpaid.
- The guard `if (!c.env.MPP_SECRET_KEY || !c.env.MASIDY_WALLET)` returns a clean 503 if secrets are missing.
- `worker-configuration.d.ts` documents both secrets as required. They must be set via `wrangler secret put`.
- The `/mcp` path is explicitly bypassed from CSRF in `worker/app.ts`.

**No issues found.** The gate is well-implemented.

---

## 5. Rate Limiting & Usage

**Status: Rate limiting works; credit integration is missing**

- `RateLimitService` (`worker/services/rate-limit/rateLimits.ts`) implements five limit types: `API_RATE_LIMIT`, `AUTH_RATE_LIMIT`, `APP_CREATION`, `LLM_CALLS`, `PUBLIC_APPS`, `SPACE_PREVIEW`.
- `usageChecker.ts` (`checkUsageAndBalance`) checks LLM credit usage via `RateLimitService.getRemainingCredits` against the Durable Object rate-limit store. It does **not** check the `userCredits` D1 balance.
- The two systems (DO-based rate limits and D1-based USDC credits) are **completely separate** and never cross-reference each other. There is no code path that checks `userCredits.balance` before allowing a model call, and no code that calls `deductCredits` after one.

---

## 6. Database

**Status: Schema good; minor migration gap in numbering**

- All three new payment tables (`user_credits`, `user_payments`, `usage_transactions`) are in `worker/database/schema.ts` with appropriate indexes and foreign keys.
- Type exports (`UserCredit`, `UserPayment`, `UsageTransaction`) are present at the bottom of schema.ts.
- Migration 0009 was applied remotely (confirmed in terminal output).

**Migration numbering gap:** The `_journal.json` shows the sequence skips from idx 7 (`0007_violet_nebula`) to idx 8 (`0006_puzzling_bloodstrike`) and then idx 9 (`0009_certain_true_believers`). The file `0006_puzzling_bloodstrike.sql` exists on disk but carries a `0006_` prefix while occupying idx 8 in the journal — and there is no `0008_*.sql` file. This is cosmetically confusing but functionally harmless because Drizzle tracks migrations by journal idx, not filename. Nothing is missing from production.

---

## 7. Frontend Routes

**Status: All routes present; one import issue**

- `src/routes.tsx` defines all seven routes: `/`, `/chat/:chatId`, `/profile`, `/settings`, `/apps`, `/app/:id`, `/discover`. No broken imports.
- `BillingSection` is imported and rendered in `settings/index.tsx`. `UsageDashboard` is imported and rendered in `profile.tsx`.
- Legal pages (`/terms`, `/privacy`) are defined.

---

## 8. Frontend Data Fetching

**Status: Mostly correct; 6 TypeScript errors**

### TypeScript errors (breaks build)

`src/utils/usage-limit-checker.tsx` has **6 type errors** (confirmed by `bun run typecheck`):

```
error TS2554: Expected 2 arguments, but got 1
  at line 138, 146, 157, 187, 195, 206
  createUsageLimitDialog(onClose)  ← missing `navigate` argument
```

The function signature at line 26 is:
```ts
function createUsageLimitDialog(onClose: () => void, navigate: (path: string) => void)
```

But all 6 internal call sites within the same file pass only `onClose`. This means the "Add credits" button in the limit dialog would never navigate — and it would fail to compile. The callers `checkCanSendPrompt` and `getBackendLimitDialog` (called from `chat.tsx` and `home.tsx`) pass a `navigate` param to the exported functions, but that param is not forwarded to the inner `createUsageLimitDialog` call.

### Query key consistency ✅

`src/lib/query-keys.ts` has hierarchical `account.payments.*` keys with user-scoped variants for all five payment endpoints. The billing and usage components use them correctly and invalidate on `account.payments.all()` after verification.

### API client ✅

All 5 payment endpoints (`getPaymentWallet`, `getPaymentBalance`, `verifyPayment`, `getPaymentHistory`, `getUsageHistory`) are implemented in `src/lib/api-client.ts` and imported correctly.

---

## 9. Environment / Config

**Status: Mostly complete; two new secrets need setting**

`worker-configuration.d.ts` correctly documents:
- `MPP_SECRET_KEY` — mppx signing key (must be set via `wrangler secret put MPP_SECRET_KEY`)
- `MASIDY_WALLET` — USDC receiving wallet (must be set via `wrangler secret put MASIDY_WALLET`)

Both are only `string` in the type, not `string | undefined`. This means TypeScript will not warn if they are missing at runtime; the payment controller and MCP route must check for them explicitly (which they do).

`CLOUDFLARE_AI_GATEWAY_ROUTE` is correctly absent from `wrangler.jsonc` (it remains in `wrangler.staging.jsonc` and `worker/types/env.d.ts` as optional `string | undefined`).

**`DISPATCHER` binding:** `worker/types/env.d.ts` declares `DISPATCHER?: DispatchNamespace` (optional) but it is **not listed in `wrangler.jsonc`**. The `isDispatcherAvailable()` utility handles this gracefully (fails open with 404), so deployed apps via dispatch namespace will simply return "not available." If permanent app deployment is intended, the binding must be added.

---

## 10. CLOUDFLARE_AI_GATEWAY_ROUTE Removal

**Confirmed fixed** — commit `6254491` removes exactly one line (`"CLOUDFLARE_AI_GATEWAY_ROUTE": "yes"`) from `wrangler.jsonc`. The only other place it still appears:
- `wrangler.staging.jsonc` — intentional, staging-only
- `worker/types/env.d.ts:25` — type declaration as optional (`CLOUDFLARE_AI_GATEWAY_ROUTE?: string`), correct
- `worker/agents/core/behaviors/think.ts:222` — reads `env.CLOUDFLARE_AI_GATEWAY_ROUTE?.trim()` with optional chaining, safe
- `worker/agents/think/model-config.ts:9` — validation function, only called when the var is non-empty

No other places. The fix is complete and correct for production.

---

## 11. What's Incomplete or Missing

### P0 — Breaks functionality

| Issue | File | Impact |
|---|---|---|
| `createUsageLimitDialog` called with 1 arg, needs 2 | `src/utils/usage-limit-checker.tsx:138,146,157,187,195,206` | TypeScript build fails; limit dialog "Add credits" button navigation broken |

### P1 — Critical feature gap

| Issue | File | Impact |
|---|---|---|
| `deductCredits` never called | No caller anywhere | Users are charged $0 for all platform usage; billing is cosmetic |
| Credit balance not checked before agent/LLM calls | `worker/services/rate-limit/usageChecker.ts` | Users with $0 balance can still use the platform indefinitely |
| `viem` not a declared direct dependency | `package.json` | Risk of breakage on lockfile update or mppx version change |

### P2 — Incomplete or production-risk

| Issue | File | Impact |
|---|---|---|
| `console.log` on every auth check | `worker/middleware/auth/routeAuth.ts:95` | Logs auth state + requirement objects on every API call; noise + potential info leak |
| Hardcoded 8-second TX confirmation wait | `src/components/billing-section.tsx:147` | Payment verification fails on congested chain; UX requires manual re-verify |
| `DISPATCHER` binding undeclared in `wrangler.jsonc` | `wrangler.jsonc` | Permanent app deployment not available |
| `handleDeleteAccount` not implemented | `src/routes/settings/index.tsx` | Calls `toast.error('Account deletion is not yet implemented')` |
| Migration numbering gap (0008 missing filename) | `migrations/` | Cosmetic; no functional impact but confusing for future migrations |
| `enableFastSmartCodeFix` and `enableRealtimeCodeFix` are hardcoded `false` with TODO | `worker/agents/core/behaviors/base.ts:354-355` | Features not exposed despite being implemented |

### P3 — Minor / future work

| Issue | File | Impact |
|---|---|---|
| Presentation and general capabilities disabled | `wrangler.jsonc:PLATFORM_CAPABILITIES` | `presentation` and `general` features not enabled |
| `UserSecretsRoutes` commented out | `worker/api/routes/index.ts:12,29-31` | Legacy secrets route disabled |
| Sentry commented out | `worker/index.ts`, `worker/app.ts` | No production error tracking |
| Image upload to Think agent builder: images are processed and passed but must be tested end-to-end | `worker/agents/core/behaviors/think.ts:405` | Per user report, images may not be reaching the builder |

---

## Prioritized Recommendations

### Fix immediately (breaks build or loses money)

1. **Fix the TypeScript errors** in `src/utils/usage-limit-checker.tsx`. Either pass `navigate` from the calling function, or make it optional with a fallback. The build is failing (`bun run typecheck` exits 1).

2. **Wire `deductCredits` into the agent/LLM flow.** The right place is `worker/services/rate-limit/usageChecker.ts` (after a successful `checkUsageAndBalance` call) or at the LLM call site in `rateLimits.ts:enforceLLMCallsRateLimit`. The `action` string should map to `think_agent`, `codegen`, etc., and `actualCost` should be the model's `creditCost`. Without this, every paying user is being given free unlimited access and the `usageTransactions` table is always empty.

3. **Add `viem` as a direct dependency** in `package.json`: `bun add viem`. Pin the version to `2.57.7` (current transitive) to prevent a silent breakage.

### Fix soon (developer experience and log hygiene)

4. **Remove the `console.log` debug line** from `worker/middleware/auth/routeAuth.ts:95`.

5. **Add `DISPATCHER` to `wrangler.jsonc`** if permanent app deployment is intended, or document clearly that it is not supported.

6. **Improve MetaMask payment confirmation** — instead of a hardcoded 8-second wait, poll the verify endpoint with retries or use `eth_getTransactionReceipt` in a polling loop until confirmed.

### Future work

7. Add credit balance check to `checkUsageAndBalance` in `usageChecker.ts` so users with $0 D1 balance are also gated (not just rate-limit DO exhaustion).

8. Investigate the image upload issue in the Think agent builder — the infrastructure for images exists in `handleUserInput`, but the user reports images are not being picked up in the builder chat.
