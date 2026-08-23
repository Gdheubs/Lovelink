# Production setup

Follow this in order. Each step ends with something you can check, so a failure
is localised to the step that caused it rather than discovered three steps later.

Nothing here has been run against a real Supabase or Cloudflare account — the
verification notes say what to expect so you can tell a working step from a
broken one, and we fix what breaks as we go.

---

## What runs where, and why

| Piece | Platform | Why not somewhere else |
| --- | --- | --- |
| Web app | **Vercel** | Next.js |
| API + realtime | **A container**: Fly, Railway, Render | Holds thousands of open WebSockets, keeps a Redis subscription, runs the room scheduler on a timer. **This cannot be serverless.** |
| Postgres | **Supabase** | Managed Postgres + pgvector |
| Redis | **Upstash** or Redis Cloud | Supabase has no Redis |
| Voice | **LiveKit Cloud** | SFU |
| DNS · WAF · CDN | **Cloudflare** | |
| Large media | **Cloudflare R2** | No egress fees |

The single most common way to get this wrong is trying to put the API on Vercel.
It will appear to work, and voice rooms will disconnect every few minutes.

---

## 1. Supabase

**Create the project.** Choose a region near your users — every query pays the
round trip. Save the database password Supabase shows you once.

**Get both connection strings.** Project Settings → Database → Connection string.
You need two, and they are not interchangeable:

| Use | Port | Where it goes |
| --- | --- | --- |
| The running app | **6543** (Transaction pooler) | `DATABASE_URL` |
| Migrations | **5432** (Direct connection) | `DATABASE_DIRECT_URL` |

Migrations need the direct one because the migration runner takes a
session-level advisory lock so two deploys cannot apply the same migration. A
transaction pooler cannot hold that lock, and both deploys would believe they
had it.

**Run the migrations** from your machine:

```bash
export DATABASE_DIRECT_URL='postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres'
export DATABASE_SSL=true
npm run migrate --workspace=@loverlink/server
```

**Check it worked.** In the Supabase SQL editor:

```sql
select count(*) from schema_migrations;                    -- expect 5
select extname from pg_extension where extname = 'vector'; -- expect one row
select relname, relrowsecurity from pg_class
 where relname in ('users','reports','direct_messages');   -- expect true for all
```

> **If `vector` is missing:** enable it under Database → Extensions, then re-run.
> **If migration 0005 fails on RLS:** you are connected as a role that does not
> own the tables. Use the connection string from Settings, not a custom user.

### RLS is on, and that is intentional

Every personal table has RLS enabled with **no permissive policies**. The API
connects as the table owner and bypasses it, so nothing changes at runtime.

This is a backstop, not the authorization model — the trust ladder lives in the
domain (ADR 0004) and must not be duplicated in SQL. What RLS buys is that if
anything else ever connects with user credentials (the SQL editor, a leaked anon
key, PostgREST), it sees nothing. See [ADR 0008](./adr/0008-managed-platform-topology.md).

**Do not enable Supabase Auth.** This app has its own, with refresh-token
rotation and ban-aware sessions. Two identity systems is worse than either.

---

## 2. Redis

**Upstash** is the easiest fit. Create a database in the same region as the API.

Take the connection string. It will start `rediss://` — the extra `s` is TLS,
and `ioredis` handles it automatically.

```
REDIS_URL=rediss://default:[password]@[host].upstash.io:6379
```

**Check it:**

```bash
redis-cli -u "$REDIS_URL" ping   # PONG
```

Redis is doing four things nothing else does here: presence with explicit
expiry, atomic rate-limit counters, cross-instance socket fan-out, and the room
chat ring buffer. It is not a cache you can drop.

> **Watch the connection count.** This app opens **five** Redis connections per
> instance — commands, bus publisher, bus subscriber, and a duplicated pair for
> the Socket.io adapter. Upstash's free tier caps concurrent connections; two
> instances is ten. Check the plan limit before scaling.

---

## 3. LiveKit Cloud

Create a project. Take the three values:

```
LIVEKIT_URL=wss://[project].livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

The secret must be at least 32 characters — LiveKit's own are. Config refuses to
start on the development default.

---

## 4. Web push keys

```bash
npx web-push generate-vapid-keys --json
```

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@yourdomain.com
```

`VAPID_SUBJECT` is not decoration: it is how a push service reaches a human when
a deployment misbehaves, rather than simply blocking it.

Push is optional. With no keys the server publishes no public key, clients never
offer to subscribe, and everything else works.

---

## 5. Cloudflare R2

Create a bucket. Then R2 → Manage API Tokens → Create token with **Object Read &
Write**, scoped to that bucket.

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=loverlink-media
R2_PUBLIC_BASE_URL=          # only if a domain serves the bucket
```

Nothing uses this yet. The port exists so the video pipeline has a boundary to
be built against; leaving it unset is fine.

---

## 6. Deploy the API

The image is built from the **repo root**, not from `apps/server`:

```bash
docker build -f apps/server/Dockerfile -t loverlink-api .
```

Verified locally: 386MB, runs as a non-root user, `/healthz` and `/readyz` green
against real Postgres and Redis.

### Environment

```bash
NODE_ENV=production
PERSISTENCE=postgres
PORT=4000
HOST=0.0.0.0

DATABASE_URL=…:6543/postgres        # transaction pooler
DATABASE_DIRECT_URL=…:5432/postgres # migrations only
DATABASE_SSL=true
DATABASE_POOL_MAX=10

REDIS_URL=rediss://…

JWT_SECRET=                          # openssl rand -base64 48
ADMIN_TOKEN=                         # openssl rand -base64 32
AUTH_ECHO_CODE=false

CORS_ORIGINS=https://loverlink.online
PUBLIC_WEB_URL=https://loverlink.online

LIVEKIT_URL=wss://…
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@yourdomain.com

MODERATOR_USER_IDS=                  # fill in after your first sign-up
LOG_LEVEL=info
LOG_PRETTY=false

TRUST_PROXY=false                    # turn on ONLY after step 8
```

**Config validates all of this at boot and refuses to start** on a development
secret, a wildcard CORS origin, a localhost database, or a public database
without TLS. A misconfigured deploy fails on line one of the log rather than
serving traffic insecurely.

### Run migrations as a release step

Against `DATABASE_DIRECT_URL`, before the new version takes traffic.

### Verify

```bash
curl https://api.loverlink.online/healthz   # {"status":"ok","persistence":"postgres"}
curl https://api.loverlink.online/readyz    # database + cache "ok"
```

In the logs you should see `redis adapter attached: multi-instance fan-out is
live`. If you instead see `no redis adapter: realtime works for ONE instance
only`, do not scale past one instance — events will not cross instances and
rooms will appear half-empty to half their members.

---

## 7. Deploy the web app

Vercel → import the repo → **Root Directory: `apps/web`**.

```
NEXT_PUBLIC_API_URL=https://api.loverlink.online
```

`apps/web/vercel.json` already sets the security headers, immutable caching for
build output, and `must-revalidate` on `sw.js` — a cached service worker is one
that cannot be updated.

**Check:** open the site, then DevTools → Application → Service Workers shows one
activated, and Manifest shows no icon errors.

---

## 8. Cloudflare

**DNS** (proxied — orange cloud):

| Record | Name | Points to |
| --- | --- | --- |
| CNAME | `@` / `www` | Vercel |
| CNAME or A | `api` | Your API host |

**SSL/TLS mode: Full (strict).** "Flexible" means Cloudflare talks to your origin
over plain HTTP — the padlock is real for the user and a lie about the second
hop.

**Lock the origin.** Until this is done, anyone who learns the origin address can
bypass Cloudflare entirely. Either:

- firewall the origin to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), or
- use Cloudflare Tunnel and stop exposing a public address at all.

**Then, and only then, set `TRUST_PROXY=true` and redeploy the API.**

That ordering matters. `TRUST_PROXY` tells the server to believe
`cf-connecting-ip` about who the client is. Behind a locked origin that is
authoritative, because Cloudflare overwrites it. On a directly reachable origin
it is attacker-controlled, and trusting it means anyone can evade every per-IP
rate limit by sending a different value on each request.

**WebSockets:** on by default. Do not enable "Cache Everything" on `api.*`.

**Verify the lock:**

```bash
curl -sI https://api.loverlink.online/healthz | grep -i cf-ray   # via Cloudflare
curl -sI http://[origin-ip]:4000/healthz                          # should FAIL
```

The second command succeeding means the origin is still open and `TRUST_PROXY`
is unsafe.

---

## 9. First moderator

Sign up through the app, then find your id:

```sql
select id, display_name from users order by created_at desc limit 5;
```

Put it in `MODERATOR_USER_IDS` and redeploy.

It is config rather than a database role deliberately: anyone who can write a
user row must not be able to mint a moderator.

---

## 10. Smoke the deployment

```bash
SMOKE_BASE_URL=https://api.loverlink.online npm run smoke --workspace=@loverlink/server
```

Expect **most of it to fail against production**, and that is correct: the smoke
test completes a signup, which needs `AUTH_ECHO_CODE=true`, and production
refuses to boot with that on. Run the full journey checks (`room-check`,
`safety-check`, `ladder-check`) against a **staging** deployment with echo on.

Against production, the honest checks are `/healthz`, `/readyz`, and a real
sign-in from a real phone.

---

## Backups

Supabase takes daily backups on paid plans. **A backup you have never restored is
a hypothesis.** Before launch, restore into a scratch project and run:

```sql
select count(*) from users;
select count(*) from trust_events;
-- the trust invariant: cached score must equal the ledger
select count(*) from users u
 where u.trust_score <> (
   select coalesce(sum(delta), 0) from trust_events where user_id = u.id
 );  -- expect 0
```

That last query is the one worth running. It is the invariant a restore is most
likely to break, and nothing else would notice.

---

## Known gaps

- **Push has never been confirmed on a physical Android device.** Everything up
  to the push service is verified — a real send to Google FCM returned 410 and
  the dead subscription was cleaned up — but nobody has watched a phone light up.
- **No load test.** Presence, rate limits and the socket layer are correct under
  test; none of it has met real concurrency.
- **`docker-compose.yml` is local development only.** It is no longer the
  production topology.
