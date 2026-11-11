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

## Work in progress

The current draft adds additive finance tables behind `FINANCE_EXPERIMENTAL=true`, an independent finance account/session flow, groups with one-time invitation links, wallets, exact-amount income/expense records with idempotent writes, edits and soft deletes, sources, monthly budgets, summaries and CSV export. The `/finance` UI covers account onboarding, group/member access, wallet controls, transaction entry/edit/delete, sources, budget, summary, group/member/source lifecycle, and planner notes/reminders/tasks. Archive v7 round-trips finance records and import markers while excluding session and invitation tokens and revoking target sessions and outstanding invitations; v6 archives remain readable. Local pending-transaction recovery uses a server lookup by idempotency key. Archive tables and existing data remain separate; do not enable the flag against a live database.

Profile pictures are limited to the signed-in user, processed into bounded WebP images, and included in finance archive export/restore. Users can opt in to browser notifications, register their own devices, and explicitly send a generic reminder to selected devices. Registration does not send a notification, and reminders never send automatically. Provider acceptance does not prove delivery; an interrupted send can have an unknown outcome and a new attempt may duplicate it. Bot integration is out of scope.

An isolated browser walkthrough exercised onboarding, wallets, transactions, planner, invitation registration, profile upload and responsive widths. A separate mocked-provider walkthrough exercised the remote reminder controls, but real push delivery and a screen-reader review remain unverified. PostgreSQL integration tests exercised concurrency, schema migration and archive/import round-trips against a disposable local PostgreSQL instance. Deployment-specific configuration and database role privileges, including whether a provider exposes finance tables through a data API, must still be checked before enabling finance in production.

## Savers import preflight

`npm run finance:preflight -- <export.json>` reads a JSON object with `users`, `wallets`, `wallet_members`, and `transactions` arrays from the Savers schema. Export `wallets.current_balance`, `wallets.target_amount`, and `transactions.amount` as decimal strings so the tool can reconcile amounts without floating-point rounding. It checks duplicate IDs, references, missing wallet members, positive transaction amounts, and balances. It outputs counts and per-wallet reconciliation and returns a nonzero exit code on invalid data. It does not write to a database or import records. Do not include the source export in version control; it may contain password hashes and personal data.

`npm run finance:import -- --source <export.json> --mapping <mapping.json>` previews the import in a transaction that is rolled back. Add `--apply` only after reviewing the output and backing up the target database. The source must additionally include `notes`, `note_reminders`, and `scheduled_tasks` arrays, even when empty. The mapping file has the shape `{ "users": { "legacy-user-uuid": "finance-user-uuid" }, "walletGroups": { "legacy-wallet-uuid": "finance-group-uuid" }, "plannerGroups": { "legacy-user-uuid": "private-finance-group-uuid" } }`. Create the target accounts and groups first. A wallet's target group must have exactly its mapped legacy members; a planner group must have only the mapped owner. Imported records use stable IDs and archived import markers; unchanged replays are skipped. Deleted records, changed source or target records, changed balances, and changed mappings fail for reconciliation without overwriting edits. Historical passwords, sessions, profile URLs, and WhatsApp delivery records are not copied; users retain their existing finance accounts and credentials. Adding members to a planner group after import grants them access to that group's planner.
