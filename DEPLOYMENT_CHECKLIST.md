# Deployment Checklist for Loverlink

Use this checklist to track your deployment progress.

## Pre-Deployment (Local)

- [ ] Clone repository locally
- [ ] Run `npm install`
- [ ] Run `npm run ci` (all tests pass)
- [ ] Run `npm run build` (both apps build successfully)
- [ ] Generate auth secrets:
  ```bash
  node -e "console.log('ACCESS_TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
  node -e "console.log('REFRESH_TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] Save these secrets somewhere secure (1Password, LastPass, etc.)

## Service Setup

### Cloudflare (5 min)
- [ ] Sign up at cloudflare.com
- [ ] Add your domain
- [ ] Update registrar's nameservers to Cloudflare
- [ ] Wait for DNS propagation (5-30 min)

### Supabase PostgreSQL (10 min)
- [ ] Sign up at supabase.com
- [ ] Create project (pick region close to backend)
- [ ] Get Connection Pooler URL → `DATABASE_URL`
- [ ] Get Direct connection URL → `DATABASE_DIRECT_URL`
- [ ] Run migrations locally:
  ```bash
  export DATABASE_DIRECT_URL='...'
  export DATABASE_SSL=true
  npm run migrate --workspace=@loverlink/server
  ```
- [ ] Verify in Supabase SQL editor:
  ```sql
  SELECT COUNT(*) FROM schema_migrations;
  SELECT extname FROM pg_extension WHERE extname = 'vector';
  ```

### Upstash Redis (5 min)
- [ ] Sign up at upstash.com
- [ ] Create Redis database
- [ ] Copy Redis URL → `REDIS_URL` (starts with `rediss://`)
- [ ] Test: `redis-cli -u "$REDIS_URL" ping`

### LiveKit Cloud (5 min)
- [ ] Sign up at livekit.cloud
- [ ] Create project
- [ ] Get:
  - [ ] `LIVEKIT_URL` (wss://...)
  - [ ] `LIVEKIT_API_KEY`
  - [ ] `LIVEKIT_API_SECRET` (verify it's 32+ chars)

### Render Backend (15 min)
- [ ] Sign up at render.com with GitHub
- [ ] Create "New Web Service"
- [ ] Select your repository
- [ ] Set:
  - [ ] Name: `loverlink-api`
  - [ ] Environment: `Docker`
  - [ ] Dockerfile path: `apps/server/Dockerfile`
  - [ ] Region: (pick same as Supabase)
- [ ] Add all environment variables:
  - [ ] `DATABASE_URL`
  - [ ] `DATABASE_DIRECT_URL`
  - [ ] `DATABASE_SSL=true`
  - [ ] `REDIS_URL`
  - [ ] `LIVEKIT_URL`
  - [ ] `LIVEKIT_API_KEY`
  - [ ] `LIVEKIT_API_SECRET`
  - [ ] `CORS_ORIGINS=https://yourdomain.vercel.app`
  - [ ] `TRUST_PROXY=true`
  - [ ] `ACCESS_TOKEN_SECRET=...`
  - [ ] `REFRESH_TOKEN_SECRET=...`
- [ ] Deploy
- [ ] Get the service URL: `https://loverlink-api.onrender.com`
- [ ] Wait for deployment to complete (~5-10 min)

### Vercel Frontend (5 min)
- [ ] Sign up at vercel.com with GitHub
- [ ] Import project
- [ ] Set root directory: `./` (root of monorepo)
- [ ] Add environment variables:
  - [ ] `NEXT_PUBLIC_API_URL=https://api.yourdomain.com` (or Render URL)
  - [ ] `NEXT_PUBLIC_REALTIME_URL=https://api.yourdomain.com`
- [ ] Deploy
- [ ] Get the Vercel URL
- [ ] Set custom domain to your Cloudflare domain

### DNS Configuration (Cloudflare)
- [ ] Add CNAME record for `api` → Render service URL
- [ ] Add CNAME record for `www` → Vercel project URL
- [ ] Keep orange cloud icon enabled (proxied)
- [ ] Wait for DNS to propagate

## Post-Deployment Testing

### Verify Connectivity
- [ ] Frontend loads: `curl -I https://yourdomain.vercel.app`
- [ ] API health: `curl https://api.yourdomain.com/healthz`
- [ ] API readiness: `curl https://api.yourdomain.com/readyz`

### Run Smoke Tests
```bash
SMOKE_API_URL=https://api.yourdomain.com npm run smoke
```

- [ ] All 37 smoke tests pass

### Manual Testing
- [ ] Open website in browser
- [ ] Create account with test email
- [ ] Log in successfully
- [ ] Create a room
- [ ] Join the room
- [ ] Send a message (text chat)
- [ ] Check Render logs for errors

## Going Live

- [ ] Update `PUBLIC_WEB_URL` in Render to your real domain
- [ ] Update `CORS_ORIGINS` in Render if needed
- [ ] Redeploy Render after env var changes
- [ ] Announce to users ✅

## Scaling (When Needed)

### Free tier is maxed out:

**Render:** Upgrade from Starter to Standard ($12/mo)
- [ ] Go to Render dashboard → Plan
- [ ] Upgrade web service

**Supabase:** Upgrade from free to Pro ($25/mo)
- [ ] Go to Supabase console → Billing
- [ ] Upgrade plan

**Upstash:** Upgrade from free tier to $7/mo
- [ ] Go to Upstash console → Plan
- [ ] Upgrade Redis instance

**LiveKit:** Start paying when exceeding 25 GiB/mo bandwidth
- [ ] Go to LiveKit console → Billing
- [ ] Set up payment method

## Troubleshooting

### "Backend not deployed yet"
- Check Render dashboard for build errors
- If Docker build failed, check "Logs" tab
- Common: Missing environment variables

### "Database connection refused"
- Verify `DATABASE_URL` has port 6543 (Transaction Pooler)
- Verify `DATABASE_SSL=true` is set
- Check Supabase project is active

### "CORS errors in browser console"
- Check `CORS_ORIGINS` exactly matches frontend URL
- Must include `https://`, not http
- Redeploy Render after changing env vars

### "WebSockets disconnecting"
- Check `REALTIME_IN_PROCESS=true` in Render
- Check Upstash Redis connection is working
- Render logs should show Socket.io connection errors

### "API returning 500 errors"
- Check Render logs in dashboard
- Common: Missing environment variable
- Add the variable, redeploy

### "Smoke test failing"
- Check smoke test logs for which step fails
- Usually: auth, database, or Redis issues
- Verify all three services are responding

## Recovery

### Need to redeploy?
```bash
# Render auto-deploys on git push
git push origin main

# Or manually redeploy in Render dashboard
# → Web Service → Manual Deploy
```

### Need to reset database?
```bash
# DANGER: This deletes all data!
# Only do in development
export DATABASE_DIRECT_URL='...'
npm run migrate --workspace=@loverlink/server down all
npm run migrate --workspace=@loverlink/server up all
```

### Need to check logs?
- **Render logs:** Render dashboard → Web Service → Logs
- **Supabase logs:** Supabase console → SQL Editor → Database Logs
- **Upstash logs:** Upstash console → Monitoring
- **Vercel logs:** Vercel dashboard → Deployments → Logs

---

**Total time to deploy: ~60-90 minutes (mostly waiting for DNS propagation)**

Good luck! 🚀
