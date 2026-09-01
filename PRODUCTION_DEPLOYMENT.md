# 🚀 PRODUCTION DEPLOYMENT GUIDE — Loverlink

**Cleaned codebase. Ready to deploy.**

This guide walks you through deploying Loverlink to production using:
- **Frontend**: Vercel (Next.js)
- **Backend**: Render (Docker)
- **Database**: Supabase (PostgreSQL)
- **Cache**: Upstash (Redis)
- **Voice**: LiveKit Cloud
- **DNS**: Cloudflare

**Estimated time: 60-90 minutes**

---

## 📋 Pre-Deployment Checklist

- [ ] You have a GitHub repository with your code
- [ ] Node.js v20+ installed locally
- [ ] A domain name (or you can use free Vercel/Render subdomains initially)
- [ ] Accounts ready: Supabase, Upstash, LiveKit, Render, Vercel, Cloudflare

---

## 🔑 Step 1: Create Service Accounts

### 1.1 Supabase Database

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub
2. Click **New Project**
   - **Database Password**: Save this securely
   - **Region**: Pick closest to your expected users
3. Click **Create New Project** (wait 2-3 minutes)
4. Go to **Project Settings → Database → Connection pooling**
5. Copy the **Transaction Pooler** URL → Save as `DATABASE_URL`
6. Go to **Project Settings → Database → Connection string**
7. Select **Direct connection** → Copy URL → Save as `DATABASE_DIRECT_URL`

✅ You should have 2 connection strings saved

### 1.2 Run Migrations

Before deploying, set up your database schema:

```bash
# From your machine (or use Render one-time job)
export DATABASE_DIRECT_URL='postgresql://postgres.[ID]:[PASS]@aws-0-[REGION].pooler.supabase.com:5432/postgres'
export DATABASE_SSL=true

npm run migrate --workspace=@loverlink/server
```

Verify in Supabase SQL Editor:
```sql
SELECT COUNT(*) FROM schema_migrations;  -- should be 5
SELECT extname FROM pg_extension WHERE extname = 'vector';  -- should exist
```

If pgvector is missing, enable it: **Database → Extensions → pgvector → Enable**

### 1.3 Upstash Redis

1. Go to [upstash.com](https://upstash.com) and sign in
2. Click **Create Database** → **Redis**
3. **Database Name**: `loverlink`
4. **Region**: Same as Render backend (usually US or EU)
5. **Eviction Policy**: `allkeys-lru`
6. Click **Create**
7. Go to **Details** tab
8. Copy the **Redis URL** (starts with `rediss://`) → Save as `REDIS_URL`

### 1.4 LiveKit Cloud

1. Go to [livekit.cloud](https://livekit.cloud)
2. Sign up and create project
3. Go to **Project Settings** and copy:
   - `LIVEKIT_URL` (format: `wss://yourproject.livekit.cloud`)
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET` (must be 32+ characters)

---

## 🐳 Step 2: Deploy Backend (Render)

### 2.1 Connect GitHub to Render

1. Go to [render.com](https://render.com) and sign in with GitHub
2. Click **Dashboard**
3. Click **New +** → **Web Service**
4. Click **Connect account** (GitHub authentication)
5. Search for your repo and click **Connect**

### 2.2 Configure Web Service

Fill in these settings:

| Setting | Value |
|---------|-------|
| **Name** | `loverlink-api` |
| **Environment** | `Docker` |
| **Branch** | `main` |
| **Dockerfile path** | `apps/server/Dockerfile` |
| **Build Command** | (leave empty) |
| **Start Command** | (leave empty) |
| **Auto-deploy** | Enable |
| **Region** | (pick same as Supabase/Upstash) |
| **Plan** | `Starter` (free tier limited) |

### 2.3 Add Environment Variables

Click **Environment** section and add each variable from `.env.render.example`:

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
PERSISTENCE=postgres
REALTIME_IN_PROCESS=true

DATABASE_URL=[from Supabase - Transaction Pooler]
DATABASE_DIRECT_URL=[from Supabase - Direct]
DATABASE_SSL=true

REDIS_URL=[from Upstash]

LIVEKIT_URL=[from LiveKit]
LIVEKIT_API_KEY=[from LiveKit]
LIVEKIT_API_SECRET=[from LiveKit, must be 32+ chars]

CORS_ORIGINS=https://[your-vercel-domain].vercel.app
PUBLIC_WEB_URL=https://[your-vercel-domain].vercel.app
TRUST_PROXY=true

ACCESS_TOKEN_SECRET=[generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
REFRESH_TOKEN_SECRET=[generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
```

### 2.4 Deploy

1. Click **Create Web Service**
2. Render starts building from your Dockerfile
3. Wait 5-10 minutes for build to complete
4. Check **Logs** tab for any errors
5. When done, copy your Render URL: `https://loverlink-api.onrender.com`

✅ Your backend is now live!

Test it:
```bash
curl https://loverlink-api.onrender.com/healthz
```

---

## ⚡ Step 3: Deploy Frontend (Vercel)

### 3.1 Import Project

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New** → **Project**
3. Click **Import Git Repository**
4. Search for your repo and click **Import**

### 3.2 Configure Project

1. **Root Directory**: Keep as `./` (root of monorepo)
2. **Framework Preset**: Vercel auto-detects Next.js
3. Click **Environment Variables**

### 3.3 Add Frontend Environment Variables

Add these variables:

```
NEXT_PUBLIC_API_URL=https://loverlink-api.onrender.com
NEXT_PUBLIC_REALTIME_URL=https://loverlink-api.onrender.com
```

Or use your custom domain if you've set up DNS:
```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_REALTIME_URL=https://api.yourdomain.com
```

### 3.4 Deploy

1. Click **Deploy**
2. Vercel builds your Next.js app (2-3 minutes)
3. When done, you get a `.vercel.app` URL: `https://[project].vercel.app`

✅ Your frontend is now live!

---

## 🌐 Step 4: Set Up DNS (Cloudflare)

### 4.1 Add Domain to Cloudflare

1. Go to [cloudflare.com](https://cloudflare.com)
2. Click **Add a Site**
3. Enter your domain name
4. Choose plan (free is fine)
5. Update your domain registrar's nameservers to Cloudflare's

### 4.2 Add DNS Records

In Cloudflare Dashboard, add these records:

| Type | Name | Content | TTL |
|------|------|---------|-----|
| CNAME | `api` | `loverlink-api.onrender.com` | Auto |
| CNAME | `www` | `[project].vercel.app` | Auto |

Optional: Point root domain to www:
| Type | Name | Content | TTL |
|------|------|---------|-----|
| CNAME | `@` | `www.yourdomain.com` | Auto |

### 4.3 Enable SSL

- Cloudflare automatically generates free SSL certificates
- Wait 15-30 minutes for DNS propagation
- Test: `nslookup api.yourdomain.com`

---

## ✅ Verification

### Test Backend

```bash
# Health check
curl -I https://api.yourdomain.com/healthz
# Should return 200 OK

# Readiness check (database connected)
curl -I https://api.yourdomain.com/readyz
# Should return 200 OK
```

### Test Frontend

1. Open `https://www.yourdomain.com` in browser
2. Should load the Loverlink app
3. Try to create an account
4. Check Render logs for any errors

### Manual Testing

1. **Sign up**: Create account with test email (18+ required)
2. **Login**: Use the code sent (check Render logs if no SMS)
3. **Create room**: Test room creation
4. **Chat**: Send a message in the room
5. **Presence**: Join with multiple users, check member list

---

## 🚨 Troubleshooting

### "Backend says Database Error"

**Check:**
- `DATABASE_URL` has port 6543 (Transaction Pooler), not 5432
- `DATABASE_SSL=true` is set
- Supabase project is active
- Migrations were run: `SELECT COUNT(*) FROM schema_migrations;`

**Fix:**
```bash
# Re-run migrations
export DATABASE_DIRECT_URL='...'
export DATABASE_SSL=true
npm run migrate --workspace=@loverlink/server
```

### "CORS errors in browser console"

**Check:**
- `CORS_ORIGINS` matches EXACTLY: `https://yourdomain.vercel.app`
- No trailing slashes
- Has `https://`, not just `yourdomain.com`

**Fix:**
1. Update `CORS_ORIGINS` in Render dashboard
2. Click **Manual Deploy** to redeploy
3. Wait 2 minutes
4. Refresh browser

### "WebSockets disconnecting every few seconds"

**Check:**
- `REALTIME_IN_PROCESS=true` is set
- Redis connection is working: check `REDIS_URL`
- Render logs show Socket.io connection warnings

**Fix:**
- Verify Upstash Redis is responding: `redis-cli -u "$REDIS_URL" ping`
- Check Render logs for Redis connection errors
- Restart Render web service if needed

### "Cannot create account (auth errors)"

**Check:**
- `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET` are set
- They are 64 hex characters each

**Fix:**
1. Generate new secrets:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update in Render dashboard
3. Manual deploy

### "LiveKit voice not working"

**Check:**
- `LIVEKIT_API_SECRET` is 32+ characters
- All LiveKit values are set correctly
- `LIVEKIT_URL` starts with `wss://`

**Fix:**
1. Verify LiveKit project is active
2. Check API key hasn't been rotated
3. Restart Render web service

### "DNS not resolving"

**Check:**
- Wait 15-30 minutes (DNS propagation)
- Verify Cloudflare nameservers at your registrar
- DNS records are added in Cloudflare dashboard

**Test:**
```bash
nslookup api.yourdomain.com
# Should show Cloudflare nameservers
```

---

## 🔄 Monitoring & Maintenance

### Daily Checks

- Monitor Render logs for errors: Dashboard → Logs
- Check Upstash Redis connection count
- Monitor Supabase database usage

### Updating Deployment

```bash
# Make code changes locally
git add .
git commit -m "feat: add new feature"
git push origin main

# Render auto-deploys on push (if enabled)
# Monitor at: Render Dashboard → Logs
```

### Rolling Back

```bash
# Revert last commit
git revert HEAD
git push origin main

# Render auto-redeploys
```

---

## 📈 Scaling When Needed

### Render Backend
- Upgrade from **Starter** → **Standard** ($12/mo) for better uptime

### Supabase
- Upgrade from **Free** → **Pro** ($25/mo) for more storage/compute

### Upstash Redis
- Upgrade from **Free** → **Starter** ($7/mo) for more commands/mo

---

## 🎯 Summary

✅ **You've deployed Loverlink!**

Your app is now:
- **Live at**: `https://yourdomain.com` (frontend)
- **Backend API**: `https://api.yourdomain.com`
- **Database**: Supabase PostgreSQL
- **Cache**: Upstash Redis
- **Voice**: LiveKit Cloud
- **Hosting**: Render + Vercel

**Users can now:**
- Sign up and log in
- Create and join rooms
- Chat with others
- Raise hands to speak (Phase 3+)

---

## 📚 Next Steps

- Monitor production logs
- Set up monitoring alerts
- Plan next feature releases
- Scale services as users grow

Good luck! 🚀
