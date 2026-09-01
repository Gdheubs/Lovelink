# Database Options Comparison for Loverlink

**TL;DR: Stick with Supabase (Postgres). MongoDB requires code changes.**

---

## Option 1: Supabase (PostgreSQL) ✅ RECOMMENDED

**Current setup — already in codebase**

### Pros
- ✅ Pre-written migrations (5 SQL files ready to go)
- ✅ pgvector extension (trust scoring algorithms already use it)
- ✅ All DAOs work out-of-the-box
- ✅ RLS (Row-Level Security) configured
- ✅ Built-in authentication infrastructure

### Cons
- ❌ Free tier: 500MB (grows quickly)
- ❌ Paid tier: $25/month

### Pricing
| Tier | Storage | Cost | Good For |
|------|---------|------|----------|
| Free | 500MB | $0 | Early testing only |
| Pro | Unlimited | $25/mo | Production users (recommended) |

### Setup Time
- **5 minutes** to create account
- **10 minutes** to run migrations
- Total: **15 minutes**

### Code Changes Required
- **ZERO** — already configured

---

## Option 2: MongoDB Atlas (NoSQL)

**Alternative approach — requires significant code changes**

### Pros
- ✅ Free tier: 512MB **always available**
- ✅ Free tier never expires (truly free)
- ✅ Generous free bandwidth
- ✅ Good for rapid prototyping

### Cons
- ❌ Requires rewriting ALL DAOs
- ❌ No pgvector (no advanced trust scoring)
- ❌ Schema flexibility means runtime type errors
- ❌ Transactions are more complex
- ❌ No RLS — must implement auth in app code

### Pricing
| Tier | Storage | Cost | 
|------|---------|------|
| Free | 512MB | $0 | 
| Pro | Unlimited | $57/mo |

### Setup Time
- **5 minutes** to create account
- **2-3 days** to rewrite DAOs (Postgres → MongoDB)
- **1 day** to test migrations
- Total: **3-5 days of engineering**

### Code Changes Required
- Rewrite `src/adapters/postgres/repositories/` (all 15+ repos)
- Migrate from SQL queries to MongoDB queries
- Handle schema validation differently
- Rewrite migrations
- Add application-level auth checks

---

## Option 3: Railway PostgreSQL

**Alternative container database service**

### Pros
- ✅ Quick deployment
- ✅ Postgres support (no rewrite needed)
- ✅ No pgvector by default (but available)

### Cons
- ❌ Pay-as-you-go pricing
- ❌ No free tier (starts at ~$5/mo)
- ❌ More complex than Supabase

### Pricing
| Tier | Cost | Usage |
|------|------|-------|
| Free | $5 credit/mo | Starter |
| Pay-as-you-go | $0.000231/CPU-hour | ~$10-50/mo typical |

### Setup Time
- **10 minutes** to create and configure
- **5 minutes** to run migrations
- Total: **15 minutes**

### Code Changes Required
- **ZERO** — works exactly like Supabase

---

## Option 4: PlanetScale (MySQL)

**Modern MySQL hosting**

### Pros
- ✅ Generous free tier
- ✅ GitHub integration
- ✅ Branching workflows

### Cons
- ❌ MySQL instead of Postgres (requires migration)
- ❌ No pgvector (fork required)
- ❌ Schema changes are complex

### Pricing
| Tier | Cost |
|------|------|
| Free | $0 (limited) |
| Pro | $8-20/mo |

### Setup Time
- **Significant** — MySQL → Postgres migration needed
- Not recommended

---

## Recommendation Matrix

| Use Case | Best Choice | Reason |
|----------|------------|--------|
| **Just launched, testing MVP** | Supabase Free | $0, immediate, no code changes |
| **Have paying users** | Supabase Pro ($25/mo) | Worth the investment, fast queries |
| **Ultra-budget conscious** | MongoDB Atlas Free | Truly free tier, but costs 3-5 days coding |
| **Medium users (1K-10K)** | Supabase Pro or Railway | Both $25-50/mo, Supabase more reliable |
| **Lots of data/users** | Supabase Pro+ or Railway Pro | Scales better than free tiers |

---

## Cost Comparison Over Time

### Scenario: 100 users, moderate usage

| Service | Month 1-3 | Month 4-6 | Month 7-12 | Year 1 |
|---------|-----------|-----------|------------|--------|
| **Supabase** | $0 (free) | $25 | $25 | $100 |
| **MongoDB** | $0 (free) | $0 (free) | $0 (free) | **$72 engineer time lost** |
| **Railway** | $5 | $15 | $20 | $150 |
| **Render + Supabase** | $7 | $32 | $32 | $288 |

> **MongoDB appears cheaper but costs 3-5 days of your time ($500-1000 in developer time)**

---

## Migration Path if You Change Your Mind

### Starting with Supabase Free, upgrading to Pro
```bash
# No migration needed!
# Same connection strings
# Just add payment method and increase plan
```

### Starting with MongoDB, moving to Postgres
```bash
# This is PAINFUL:
# - Dump MongoDB collections
# - Transform to relational schema
# - Migrate each DAO
# - Run new migrations
# - Test everything again
# Estimated: 2-3 days of work
```

### Starting with Supabase Free, moving to Railway
```bash
# Relatively easy:
# - Create Railway Postgres database
# - Export Supabase schema
# - Import to Railway
# - Update CONNECTION_URL
# - Redeploy
# Estimated: 1-2 hours
```

---

## pgvector Dependency

**Critical:** The Loverlink domain uses pgvector for trust scoring algorithms.

If you use MongoDB, you'll lose this:
```typescript
// domain/rules/trustLadder.ts
// Relies on pgvector for similarity calculations
// Would need to rewrite entirely for MongoDB
```

Options:
1. **Keep using Postgres** (Supabase or Railway)
2. **Use vector alternatives**: Weaviate, Pinecone (adds another service)
3. **Reimplement trust scoring** without vectors (loses sophisticated matching)

---

## My Recommendation: START WITH SUPABASE FREE

**Why:**
1. ✅ Zero code changes
2. ✅ Zero setup time (15 min)
3. ✅ $0 to start
4. ✅ Easy path to $25/mo when you need it
5. ✅ No technical debt

**Budget path:**
- **Months 1-3**: Supabase Free ($0) + Render Starter ($7) = **$7/mo**
- **Months 4+**: Supabase Pro ($25) + Render Starter = **$32/mo**

**If Supabase gets too expensive later:**
- Move to Railway Postgres (same code, $20-50/mo)
- Takes 2 hours, not 3 days

---

## MongoDB Alternative (Only If You Must)

If you **absolutely must** use MongoDB:

1. **Plan 3-5 days of rewriting**
2. **Start with free tier** (MongoDB Atlas 512MB)
3. **Lose pgvector functionality** (reimplement trust scoring)
4. **Accept eventual migration to Postgres** (it will happen)

**Is it worth it?** 
- Saves $25/mo
- Costs $500-1000 in engineer time
- **Math: Not worth it**

---

## Final Verdict

| Option | Recommendation |
|--------|-----------------|
| **Supabase (Postgres)** | ✅✅✅ START HERE |
| **MongoDB Atlas** | ⚠️ Only if you hate Postgres |
| **Railway Postgres** | ✅ Good backup plan |
| **PlanetScale (MySQL)** | ❌ More pain than gain |

---

## Questions?

See the main [BUDGET_DEPLOYMENT.md](./BUDGET_DEPLOYMENT.md) for step-by-step setup instructions.
