# 💰 Budget-Friendly Deployment Guide for Loverlink

**Total Estimated Monthly Cost: $7-15/month** (can be free initially with free tiers)

> **CRITICAL:** This app maintains persistent WebSocket connections, so it **CANNOT run on Vercel, AWS Lambda, or any serverless platform**. The backend MUST run on a container platform.

---

## 📊 Recommended Stack (Cheapest Option)

| Component | Service | Free Tier | Cost | Why |
|-----------|---------|-----------|------|-----|
| **Web Frontend** | Vercel | ✅ Yes | $0 | Next.js native, perfect fit |
| **Backend API** | Render.com | ✅ Yes (limited) | $7-15/mo | Containers, WebSockets, easy Docker |
| **Database** | Supabase | ✅ Yes (500MB) | $25/mo (paid) | Postgres + pgvector, or start free |
| **Redis** | Upstash | ✅ Yes (10K cmd/day) | Free tier or $7/mo | Free tier might be enough for small user base |
| **Voice** | LiveKit Cloud | ✅ Yes (free tier) | Free or $50+/mo | Free tier: 25 GiB bandwidth/mo |
| **DNS/CDN** | Cloudflare | ✅ Yes | $0 | Free SSL, DDoS protection |

**Better Database Alternative: MongoDB Atlas** (if you want to migrate off Postgres)
- Free tier: 512MB
- Shared cluster, completely free, always available
- No immediate cost, production-ready

---

## 🚀 STEP-BY-STEP DEPLOYMENT

### Phase 1: Frontend (Vercel) — 5 minutes

#### 1.1 Connect your GitHub repo to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Sign in with GitHub
3. Click "Import Project"
4. Select your repository
5. **Important:** Under "Root Directory", select `./` (root)
6. Vercel will auto-detect Next.js in `apps/web`

#### 1.2 Environment Variables for Frontend

In Vercel dashboard → Project Settings → Environment Variables, add:

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_REALTIME_URL=https://api.yourdomain.com
```

✅ Deploy → Vercel gives you a free `.vercel.app` subdomain

---

### Phase 2: Backend (Render.com) — 15 minutes

#### 2.1 Prepare Render.com account

1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Click "New +" → "Web Service"
4. Connect your GitHub repo

#### 2.2 Configure the Web Service

| Setting | Value |
|---------|-------|
| **Name** | `loverlink-api` |
| **Environment** | `Docker` |
| **Region** | Pick closest to your users |
| **Branch** | `main` |
| **Dockerfile path** | `apps/server/Dockerfile` |
| **Build Command** | (leave empty, Dockerfile handles it) |
| **Start Command** | (leave empty, Dockerfile handles it) |

#### 2.3 Add Environment Variables in Render

Click "Environment" and paste these (we'll fill them in after setting up other services):

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
PERSISTENCE=postgres
REALTIME_IN_PROCESS=true

# These will be filled after creating the services below
DATABASE_URL=postgresql://...
DATABASE_DIRECT_URL=postgresql://...
REDIS_URL=rediss://...
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...

# Security
TRUST_PROXY=true
CORS_ORIGINS=https://yourdomain.vercel.app

# Push notifications (optional, can be set later)
# VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# VAPID_SUBJECT=mailto:your@email.com
```

✅ Deploy → Render will deploy from Docker image automatically

---

### Phase 3: Database (Supabase) — 10 minutes

#### 3.1 Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign in with GitHub
3. Click "New Project"
4. Choose organization + project name
5. **Region**: Pick closest to your backend (Render)
6. Create database

#### 3.2 Get Connection Strings

1. Go to Project Settings → Database → Connection Pooling
2. Copy the "Transaction Pooler" connection string → `DATABASE_URL`
3. Go to Project Settings → Database → Connection string
4. Copy the direct connection (port 5432) → `DATABASE_DIRECT_URL`
5. Both should look like:
   ```
   postgresql://postgres.[PROJECT_ID]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```

#### 3.3 Apply Migrations

From your **local machine** (or in a one-time Render job):

```bash
# Set the environment
export DATABASE_DIRECT_URL='postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres'
export DATABASE_SSL=true

# Run migrations
npm run migrate --workspace=@loverlink/server
```

✅ Verify in Supabase SQL editor:
```sql
SELECT COUNT(*) FROM schema_migrations;  -- should show 5
SELECT extname FROM pg_extension WHERE extname = 'vector';  -- should show pgvector
```

#### 3.4 Copy connection strings to Render

1. In Render dashboard, paste into Environment Variables:
   - `DATABASE_URL` = Transaction Pooler
   - `DATABASE_DIRECT_URL` = Direct connection

---

### Phase 4: Redis (Upstash) — 5 minutes

#### 4.1 Create Upstash Database

1. Go to [upstash.com](https://upstash.com)
2. Sign in
3. Click "Create Database"
4. Choose "Redis"
5. **Region**: Same as Render backend
6. **Eviction Policy**: `allkeys-lru`

#### 4.2 Get Connection String

1. Copy the Redis URL (starts with `rediss://`)
2. Paste into Render Environment Variables as `REDIS_URL`

**Free Tier Limits:**
- 10,000 commands/day
- For small user base, this is plenty
- If needed, upgrade to $7/mo for unlimited

---

### Phase 5: LiveKit (Voice) — 5 minutes

#### 5.1 Create LiveKit Cloud Project

1. Go to [livekit.cloud](https://livekit.cloud)
2. Sign up
3. Create new project
4. Get these values:
   ```
   LIVEKIT_URL=wss://[project].livekit.cloud
   LIVEKIT_API_KEY=[your-api-key]
   LIVEKIT_API_SECRET=[your-api-secret] (min 32 chars)
   ```

#### 5.2 Add to Render Environment

Paste into Render dashboard:
```
LIVEKIT_URL=wss://yourproject.livekit.cloud
LIVEKIT_API_KEY=your-key-here
LIVEKIT_API_SECRET=your-secret-here
```

**Free Tier:**
- 25 GiB bandwidth/month
- Perfect for testing
- Production: $0.005/min per participant

---

### Phase 6: DNS Setup (Cloudflare) — 10 minutes

#### 6.1 Add your domain to Cloudflare

1. Go to [cloudflare.com](https://cloudflare.com)
2. Sign up
3. Add site → Enter your domain
4. Update your registrar's nameservers to Cloudflare's

#### 6.2 Create DNS Records

In Cloudflare dashboard, add these records:

```
Type    | Name    | Content
--------|---------|------------------------------------------
CNAME   | www     | [your-app].vercel.app
CNAME   | api     | [render-app].onrender.com
A       | @       | 76.76.19.21 (Cloudflare's IP)
```

Or use Vercel's and Render's auto-configuration.

#### 6.3 Enable Proxy on Cloudflare

- Set the orange cloud icon on all records (proxied, not DNS only)
- Get free SSL/TLS certificate automatically

✅ Wait 5-10 minutes for DNS propagation

---

## 🔧 Final Configuration

### Update Frontend `.env` Files

#### `apps/web/.env.local` (or Vercel Environment Variables)

```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_REALTIME_URL=https://api.yourdomain.com
```

### Update Backend Configuration

All environment variables should already be in Render. The app reads from `config.ts` which validates everything at startup.

---

## ✅ Verification Checklist

Run these tests to confirm deployment:

### Local Tests (before pushing)
```bash
npm run ci                    # Format, lint, typecheck, unit tests
npm run test:integration      # Integration tests
npm run build                 # Build both apps
```

### Post-Deployment Tests

```bash
# 1. Frontend is live
curl -I https://yourdomain.com

# 2. Backend is responding
curl https://api.yourdomain.com/healthz

# 3. Database is connected
curl https://api.yourdomain.com/readyz

# 4. Smoke test against production
npm run smoke  # (run from your machine, pointing to prod URLs)
```

---

## 💡 Cost Breakdown (Monthly)

| Service | Free Tier | Paid Tier (if needed) |
|---------|-----------|----------------------|
| Vercel | ✅ Free | $20 (Pro, not needed) |
| Render | Limited | $7 (Hobby) to $12 (Standard) |
| Supabase | ✅ 500MB free | $25 (Pro, if you outgrow) |
| Upstash | ✅ 10K cmd/day | $7 (starter) |
| LiveKit | ✅ 25 GiB/mo | Pay-as-you-go after |
| Cloudflare | ✅ Free | $20 (Pro, for extra features) |
| **TOTAL** | **$0** | **$7-15/mo** (very affordable!) |

---

## 🚨 Important Notes

### WebSocket Persistence
- ✅ Render supports persistent WebSocket connections
- ✅ Upstash works with Socket.io adapter
- ✅ Vercel only handles Next.js frontend (API proxy not needed)

### Database Choice: Postgres vs MongoDB

**Stick with Supabase (Postgres)** because:
- ✅ Already configured in your codebase
- ✅ pgvector extension for trust scoring
- ✅ Migrations are pre-written
- ❌ MongoDB requires code changes (DAOs, migrations)

**Only switch to MongoDB if:**
- You want completely free tier (MongoDB Atlas: 512MB, always free)
- You don't mind code refactoring

### Scaling Later

When you outgrow free tiers:
- **Render**: Upgrade from $7 → $12 → pay-as-you-go
- **Supabase**: Upgrade from $25 → $50+
- **Upstash**: Upgrade from free → $7 → $28
- **LiveKit**: Starts billing automatically when you exceed free bandwidth

---

## 🆘 Troubleshooting

### "Backend not connecting to database"
- Check `DATABASE_URL` is correct (Transaction Pooler port 6543)
- Check SSL is enabled in Supabase connection string
- Verify migrations ran: `SELECT COUNT(*) FROM schema_migrations;`

### "WebSockets disconnecting on Render"
- Ensure `REALTIME_IN_PROCESS=true` is set
- Check Redis connection with: `curl https://api.yourdomain.com/healthz`

### "CORS errors in frontend"
- Update `CORS_ORIGINS` in Render to your Vercel domain
- Should be: `https://yourdomain.vercel.app` (exact, with https)

### "LiveKit not working"
- Verify `LIVEKIT_API_SECRET` is min 32 characters
- Check you've saved environment variables in Render AND redeployed

### "DNS not resolving"
- Wait 15-30 minutes for propagation
- Check with: `nslookup api.yourdomain.com`
- If still broken, verify nameservers at your registrar

---

## 🎯 Next Steps

1. **Create all service accounts** (Vercel, Render, Supabase, Upstash, LiveKit, Cloudflare)
2. **Deploy frontend first** (Vercel is fastest)
3. **Set up database** (Supabase, run migrations)
4. **Deploy backend** (Render with all env vars)
5. **Configure DNS** (Cloudflare)
6. **Test thoroughly** before telling users about it!

---

## 📞 Getting Help

- **Render issues**: [docs.render.com](https://docs.render.com)
- **Supabase issues**: [supabase.com/docs](https://supabase.com/docs)
- **Upstash issues**: [upstash.com/docs](https://upstash.com/docs)
- **Loverlink issues**: Check [docs/deployment.md](./docs/deployment.md)

Good luck! 🚀
