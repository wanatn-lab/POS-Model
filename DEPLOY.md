# Deploy guide (for Codex / developer)

Cloudflare account: `jkqr Order` (the account id is in `wrangler.jsonc`; do not copy it elsewhere).
Workers: production `order` (top-level config) and staging `thongyoi` (`env.staging`).
`npm run deploy:staging` deploys only `thongyoi`; deploying production is a separate action that needs the owner's approval.
Staging has its own Durable Object storage (separate from production) and `AUTH_MODE=log`.

## 1. Staging deploy (does not touch Vercel)
1. `cd JinkoOrderCloudflare && npm ci --no-audit --no-fund`
2. `npm test` (expected: all tests pass; no failures)
3. `npx wrangler login` (shop owner approves in browser)
4. Secrets, staging only (owner enters values; never paste into chat/commits). Always add `--env staging`:
   - `npx wrangler secret put SESSION_SECRET --env staging`
   - `npx wrangler secret put OWNER_PASSWORD --env staging`
   - `npx wrangler secret put STAFF_PASSWORD --env staging`
   - Optional: `BILL_READER_TOKEN`, `ADMIN_TOKEN` (see section 5 for meaning and length)
5. Dry run (no upload): `npx wrangler deploy --env staging --dry-run`. Then deploy: `npm run deploy:staging`
   (= `wrangler deploy --env staging`) -> note the *.workers.dev URL. Never run plain `wrangler deploy` (that targets production `order`).
6. Staging checks (with `AUTH_MODE=log`; open `npx wrangler tail --env staging` in a second terminal):
   - Public ordering: a customer opens a table URL, places an order and sees their order history.
   - Staff login: `/admin` with `STAFF_PASSWORD` (orders, tables, bills incl. cancel/reprint).
   - Owner login: `/admin` with `OWNER_PASSWORD` (menu, settings, devices).
   - Table status: `/table-status` works for staff and owner.
   - Logs: every `{"evt":"auth.deny",...}` line in the tail is reviewed. A deny for a legitimate action must be fixed before enforcing; a deny for an unauthorised request is expected.
   - Printing is not part of this staging check (`counter-print.html`, see "Known gaps" in section 5).

## 2. Data
- Backup anytime: GET /api/_admin/export with header `Authorization: Bearer <ADMIN_TOKEN>`; restore via POST /api/_admin/import.
- No Upstash->Cloudflare exporter written yet. Option: start clean (menu/settings re-entered; orders are daily).

## 3. Go-live (only after all tests pass)
- Production Worker `order` already exists (top-level config in `wrangler.jsonc`): set its secrets, then deploy only after staging is verified and the owner approves.
- Decide domain/QR URL (table QR codes point to the old URL).
- External integrations must be verified separately. `counter-print.html` must not be used with `AUTH_MODE=enforce` until device-token support exists.

## 4. Rollback
- Staging: `npx wrangler rollback --env staging` (or `npx wrangler versions list --env staging` to pick a version).
- Vercel stays untouched until go-live is confirmed; point apps back to jinko-order.vercel.app.

## Notes
- All API requests run one at a time inside a single Durable Object (prevents double claim of a print job).
- Verified free limits: 100k Worker requests/day; DO SQLite 100k rows written/day. Est. one printer polling ~14k requests/day.
- NOT yet verified: Cloudflare terms on commercial use of the free plan - check before go-live.

## 5. Access control (P0 #1) — read before deploying this branch

Every `/api/*` call is now checked against the access matrix in `src/auth.js` (`RULES`). Roles:
public, customer (table pass), device (print device token), reader (Bill Summary), staff, owner.

### Settings (Worker secrets / variables)
| Name | Kind | Meaning |
|---|---|---|
| `SESSION_SECRET` | secret, >= 32 chars | signs login sessions and table passes. Changing it logs everyone out |
| `OWNER_PASSWORD` | secret, >= 12 chars | owner login (everything, incl. menu edits, settings, devices; staff may only mark items sold out) |
| `STAFF_PASSWORD` | secret, >= 12 chars | staff login (orders, tables, bills incl. cancel/reprint) |
| `BILL_READER_TOKEN` | secret, >= 32 chars, optional | read-only token for Bill Summary (`GET /api/bill-history` only) |
| `ADMIN_TOKEN` | secret, optional | backup export/import only (`/api/_admin/export`, `/api/_admin/import`). Unrelated to staff/owner login; if not set those endpoints answer 404 |
| `AUTH_MODE` | variable | `enforce` (default, also for any unknown value), `log`, or `off` |
| `ORDER_RATE_PER_MIN` | variable, optional | orders per table per minute (default 10; per client 3x) |
| `ROTATION_GRACE_HOURS` | variable, optional | how long an old device token keeps working after a rotation (default 168) |

Generate values with e.g. `openssl rand -base64 48`. Never paste them into chat or commits.
`AUTH_MODE` does not affect `ADMIN_TOKEN`.
`AUTH_MODE` is set in `wrangler.jsonc` (`env.staging.vars`, currently `log`). Changing it means editing that file and deploying again
(`npm run deploy:staging`). Do not rely on a Cloudflare dashboard edit: the next deploy overwrites it with the value from the file.

### Rollout (staging first)
1. Set the secrets above. If a password is missing or too short, that login answers 503.
2. Deploy with `AUTH_MODE=log`. Nothing is blocked; refusals appear in `wrangler tail` as
   `{"evt":"auth.deny",...}` (no secrets or addresses are logged). Customers already receive table passes.
3. Walk through: customer order + history, /admin and /table-status login (staff and owner), bill cancel.
   Fix anything that logs `auth.deny` for a legitimate action.
4. Switch to `AUTH_MODE=enforce`: change `env.staging.vars.AUTH_MODE` in `wrangler.jsonc`, then deploy again.

### Print devices
Owner only: `POST /api/devices` `{action:"create", name}` returns the token **once** (`dev_xxxxxxxxxxxx.<secret>`);
the server keeps only a hash. Send it as `Authorization: Bearer <token>`. `rotate` issues a new token and keeps the
old one valid until `finish-rotation` (or the grace period ends); `revoke` cuts a device off immediately.

### Rollback
- Fast: change `AUTH_MODE` to `off` in `wrangler.jsonc` and deploy again (the change only takes effect after that deploy). The pre-filter, checks, table passes and customer filtering all stop.
  Device management and login stay available (and owner-only). Not yet verified on a real Cloudflare Worker.
- Full: redeploy the previous Worker version. No data migration is involved; new keys are all prefixed `auth:`.

### Known gaps
- `public/counter-print.html` (iMin browser page) cannot hold a device credential. When the server answers 401/403 it shows a
  Thai message (id `authBanner`), stops polling and makes no further requests until the page is reloaded. It works as before
  with `AUTH_MODE=off`/`log`. Under `AUTH_MODE=enforce` it is expected to stop polling until device-token support for this page is
  implemented (separate piece of work), so do not enforce on a shop that still prints through this page.
- A customer holding a table pass can only order for that table. If they move to another table they can order there only after
  staff clear the old table (the old pass dies) or the pass expires (8 h); staff can always place the order.
- The login gate (`public/auth-gate.js`) asks for a login on page load only when `/api/auth/me` reports `mode: "enforce"`;
  with `off`/`log` the admin pages open as before and the box appears only if a protected call really returns 401/403.
- Anyone who knows the table URL can still *place* an order for that table (QR codes carry no signature by design).
- Passwords are shared per role, so the log cannot say which staff member did something.
- A session cannot be revoked individually; changing `SESSION_SECRET` ends all of them (12 h lifetime).
