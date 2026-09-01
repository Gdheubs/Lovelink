# ⚡ Loverlink Deployment — Quick Reference

## 🚀 30-Second Overview

```
User → Vercel (Next.js)
         ↓
      Cloudflare (DNS)
         ↓
      Render (Backend + Socket.io)
         ├→ Supabase (PostgreSQL)
         ├→ Upstash (Redis)
         └→ LiveKit (Voice)
```

**Cost**: $0 free tier → $7-32/mo when needed

---

## 📋 5-Step Setup (60-90 min)

| Step | Service | Time | Cost |
|------|---------|------|------|
| 1 | Cloudflare DNS | 5m | $0 |
| 2 | Supabase Database | 10m | $0 |
| 3 | Upstash Redis | 5m | $0 |
| 4 | LiveKit Voice | 5m | $0 |
| 5 | Render Backend | 10m | $7/mo |
| 6 | Vercel Frontend | 5m | $0 |
| — | DNS propagation | 15-30m | — |

---

## 🔑 Create These Accounts (In Order)

```
1. cloudflare.com         → Add your domain
2. supabase.com          → Create project (pick region)
3. upstash.com           → Create Redis (same region)
4. livekit.cloud         → Create project
5. render.com            → Connect GitHub
6. vercel.com            → Connect GitHub
```

---

## 🔗 Connection Strings

You'll collect exactly these 7 values:

```
1. DATABASE_URL              (Supabase Transaction Pooler, port 6543)
2. DATABASE_DIRECT_URL       (Supabase Direct, port 5432)
3. REDIS_URL                 (Upstash, starts with rediss://)
4. LIVEKIT_URL               (LiveKit Cloud, wss://...)
5. LIVEKIT_API_KEY           (LiveKit)
6. LIVEKIT_API_SECRET        (LiveKit, must be 32+ chars)
7. CORS_ORIGINS              (Your Vercel domain)
```

---

## ⚙️ Render Environment Variables

Copy-paste this block, fill in values from above:

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
PERSISTENCE=postgres
REALTIME_IN_PROCESS=true

DATABASE_URL=[from Supabase]
DATABASE_DIRECT_URL=[from Supabase]
DATABASE_SSL=true

REDIS_URL=[from Upstash]

LIVEKIT_URL=[from LiveKit]
LIVEKIT_API_KEY=[from LiveKit]
LIVEKIT_API_SECRET=[from LiveKit]

CORS_ORIGINS=https://yourdomain.vercel.app
PUBLIC_WEB_URL=https://yourdomain.vercel.app
TRUST_PROXY=true

ACCESS_TOKEN_SECRET=[generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
REFRESH_TOKEN_SECRET=[generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
```

---

## 🗄️ Database Setup (Supabase Only)

Run these once from your machine:

```bash
export DATABASE_DIRECT_URL='postgresql://postgres.[ID]:[PASS]@aws-0-[REGION].pooler.supabase.com:5432/postgres'
export DATABASE_SSL=true
npm run migrate --workspace=@loverlink/server
```

Verify in Supabase SQL editor:
```sql
SELECT COUNT(*) FROM schema_migrations;  -- expect: 5
SELECT extname FROM pg_extension WHERE extname = 'vector';  -- expect: pgvector
```

---

## 🧪 Verify After Deployment

```bash
# Check frontend
curl -I https://yourdomain.vercel.app

# Check backend health
curl https://api.yourdomain.com/healthz
curl https://api.yourdomain.com/readyz

# Run smoke tests (from local machine)
npm run smoke
```

---

## 💡 Common Mistakes & Fixes

| Error | Fix |
|-------|-----|
| "Connection refused" | Use Transaction Pooler (port 6543), not direct (5432) |
| "CORS errors" | Set CORS_ORIGINS to EXACT Vercel URL with https:// |
| "WebSocket dropping" | Ensure REALTIME_IN_PROCESS=true |
| "DNS not working" | Wait 15-30 min, check with `nslookup api.yourdomain.com` |
| "Database migrations fail" | Verify DATABASE_DIRECT_URL (port 5432), not pooler |
| "Render build fails" | Check logs in Render dashboard → Logs tab |

---

## 📊 Monthly Costs (Production)

| Tier | Total | Breakdown |
|------|-------|-----------|
| Free (3 mo) | $0 | All free tiers |
| Entry | $32 | Render $7 + Supabase $25 |
| Growth | $50-100 | Upgrading services as you scale |

---

## 🎯 Phase Status After Deployment

| Phase | Works | Notes |
|-------|-------|-------|
| 0 | ✅ | Foundation verified |
| 1 | ✅ | Auth + profiles |
| 2 | ✅ | Text chat + presence |
| 3 | ✅ | Voice with LiveKit |
| 4 | ✅ | Safety & moderation |
| 5 | ✅ | Surprises & trust ladder |
| 6 | 🚧 | Polish (not started) |

---

## 📚 Full Guides

- [BUDGET_DEPLOYMENT.md](./BUDGET_DEPLOYMENT.md) — Detailed step-by-step
- [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) — Track progress
- [DATABASE_OPTIONS.md](./DATABASE_OPTIONS.md) — Compare databases
- [docs/deployment.md](./docs/deployment.md) — Original deployment doc

---

## 🆘 Need Help?

- **Render issues**: [docs.render.com](https://docs.render.com)
- **Supabase issues**: [supabase.com/docs](https://supabase.com/docs)
- **Vercel issues**: [vercel.com/docs](https://vercel.com/docs)
- **Cloudflare DNS**: [developers.cloudflare.com](https://developers.cloudflare.com)

---

**Ready to deploy?** Start with [BUDGET_DEPLOYMENT.md](./BUDGET_DEPLOYMENT.md)
