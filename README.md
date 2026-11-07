# POS Model

> **Never deploy this repository to Worker `order`.** `order` is the Jinko production Worker.
> A plain `wrangler deploy` here targets only `jinko-central-staging`; `wrangler deploy --env staging` targets `thongyoi`.
> Production deployment must use a separately named Worker and an explicit, owner-approved workflow. See `DEPLOY.md`.

Backup template of the Cloudflare restaurant ordering system, captured from
`jinko-qr` commit `94a2fdb` after the Thongyoi admin redesign.

## Included

- Customer ordering page and admin dashboard
- Table, menu, receipt, kitchen, printer, and bill-history features
- Cloudflare Worker and Durable Object source
- Automated tests and deployment documentation

## Before using this for another restaurant

1. Do not deploy with the existing `wrangler.jsonc` values. Replace the Worker
   names and `account_id` with values for the new restaurant.
2. Configure a separate staging Worker and Durable Object before production.
3. Set secrets only with `wrangler secret put`; never put passwords, tokens, or
   `.dev.vars` files in Git.
4. Update the saved shop settings from the admin page after deployment.
5. Run tests and verify staging before any production deployment.

This repository intentionally excludes local dependencies, Wrangler state, and
secret files.
