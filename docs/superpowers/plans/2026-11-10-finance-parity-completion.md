# Finance parity completion

Continue on a branch based on `development`; bot integration is out of scope.

1. Implement an operator-run Savers importer with explicit legacy-user, wallet-group and private planner-group mappings. Validate every source record, reconcile wallet balances with exact decimals, and reject a wallet if its mapped membership differs from the target group. Planner groups must be private to their mapped user. Keep existing accounts and records intact. Use stable identifiers and fail closed on conflicts; run writes in one transaction and support safe replay. Exported bcrypt hashes and session tokens must never be copied or printed.
2. Complete manual reminder delivery with explicit opt-in and a separate send action. Preserve the current-device path and add properly scoped finance subscriptions if remote delivery is needed; never send automatically.
3. Audit all finance flows, schema upgrades, archive compatibility, authorization, concurrency, privacy, UI and deployment. Fix findings, verify with isolated data and document any unavailable PostgreSQL or real-browser checks.
4. Commit reviewed changes and open a PR to `development`. Do not delete `development`.
