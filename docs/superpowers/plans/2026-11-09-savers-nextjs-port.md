# Savers features in Hall of Achievements

**Goal:** Add the Savers and TrackMoney financial workflows to Hall using Next.js, TypeScript and the existing PostgreSQL connection, without changing existing archive data or flows.

**Architecture:** Introduce a separate `/finance` application area and `/api/finance` routes. Use additive `finance_` tables with their own identities, sessions, groups, memberships, wallets, transactions, sources, budgets and planner records. Hall's owner session cannot identify a finance group member, so a separate authenticated finance identity and server-side membership checks are required for shared-wallet parity. Never accept a client-supplied user ID as proof of identity.

**Sources:** `G:/Projects/Savers/MERGE_PREP.md`, `apps/web/src` and `services/local-api/src`; `G:/Projects/TrackMoney/app` and `database/migrations`. The source SQL includes destructive statements and must not be executed against Hall's database.

## Constraints

- Preserve the existing Hall UI, authentication, data and service worker. Namespace new routes, tables and styles.
- Store money as exact decimal values or integer minor units; compute balances from one authoritative ledger and use transaction locks and idempotency for mutations.
- Enforce membership and group ownership in server queries; bind wallets, sources and transactions to the same group.
- Do not store credentials or session tokens in browser localStorage. Retain private responses, CSRF protection and secure cookies.
- Do not enable automatic messages or notifications as a side effect of installation, login or saving records.
- Extend both database initialization paths and versioned export/restore; verify old archives and existing databases remain compatible.
- Keep any import and production data migration separate from implementation; reconcile counts and balances on a copy before a cutover.

## Delivery sequence

1. Define finance identities, session lifecycle, group membership and API contracts. Add namespaced, additive schema with migrations and authorization checks.
2. Implement group, wallet and transaction APIs with exact amounts, atomic balance checks and tests for concurrent writes and cross-group access. Add sources, budgets, summaries and exports.
3. Port the wallet and group UI into `/finance`, scoped to the existing design system. Preserve Hall navigation, authentication and archive behavior.
4. Add notes, reminders and scheduled-task metadata with explicit notification controls. Integrate the bot through authenticated internal endpoints only after the contracts and delivery semantics are verified.
5. Add finance backup/restore, legacy-data import tooling, and reconciliation against an isolated copy. Verify old Hall archives, existing data and rollback before any live migration.

## Source behavior to retain

- Savers: regular and goal wallets, wallet members, income/expense records, categories, notes, planner, profile and export flows.
- TrackMoney: group membership and roles, sources, monthly budgets, summaries and transaction exports.
- Planner recurrence values include once/daily/weekly/monthly for tasks and none/daily/weekly/monthly/yearly for note reminders.

## Verification

Use isolated PGlite and a disposable PostgreSQL database for migrations and financial concurrency; never run the source `DROP`/`TRUNCATE` script. Verify authorization across members and groups, old and new backup round trips, existing Hall tests, and real browser behavior at desktop and mobile sizes. Record any integration that cannot be verified without external bot or storage access.
