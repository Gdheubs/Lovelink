#!/bin/bash
# =============================================================================
# Loverlink Automated Deployment Script
#
# This script handles the complete deployment to Render + Vercel + Supabase
# Usage: ./deploy.sh
# =============================================================================

set -e

echo "🚀 Loverlink Deployment Starting..."
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# =============================================================================
# Step 1: Pre-deployment Checks
# =============================================================================
echo -e "${YELLOW}Step 1: Running pre-deployment checks...${NC}"

# Check if git is clean
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}✗ Error: You have uncommitted changes. Commit or stash them first.${NC}"
    exit 1
fi

# Verify Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}✗ Error: Node 20+ required. You have $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node version OK: $(node -v)${NC}"

# =============================================================================
# Step 2: Install and Build
# =============================================================================
echo ""
echo -e "${YELLOW}Step 2: Installing dependencies and building...${NC}"

npm ci --ignore-scripts
npm run build

echo -e "${GREEN}✓ Build successful${NC}"

# =============================================================================
# Step 3: TypeScript Check
# =============================================================================
echo ""
echo -e "${YELLOW}Step 3: Type checking...${NC}"

npm run typecheck

echo -e "${GREEN}✓ No TypeScript errors${NC}"

# =============================================================================
# Step 4: Linting
# =============================================================================
echo ""
echo -e "${YELLOW}Step 4: Linting code...${NC}"

npm run lint

echo -e "${GREEN}✓ Lint passed${NC}"

# =============================================================================
# Step 5: Git Commit & Push
# =============================================================================
echo ""
echo -e "${YELLOW}Step 5: Committing changes...${NC}"

if [ -n "$(git status --porcelain)" ]; then
    git add .
    git commit -m "chore: cleanup - remove tests and dev dependencies" || true
    git push origin main
    echo -e "${GREEN}✓ Changes pushed to GitHub${NC}"
else
    echo -e "${YELLOW}⊘ No changes to commit${NC}"
fi

# =============================================================================
# Step 6: Environment Setup Guide
# =============================================================================
echo ""
echo -e "${GREEN}✅ Pre-deployment ready!${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo ""
echo "1️⃣  Set up Supabase Database:"
echo "   • Go to https://supabase.com"
echo "   • Create new project (pick region)"
echo "   • Copy connection strings from Project Settings → Database"
echo "   • Save to notes: DATABASE_URL, DATABASE_DIRECT_URL"
echo ""
echo "2️⃣  Run migrations against Supabase:"
echo "   export DATABASE_DIRECT_URL='postgresql://...'"
echo "   export DATABASE_SSL=true"
echo "   npm run migrate --workspace=@loverlink/server"
echo ""
echo "3️⃣  Set up Redis (Upstash):"
echo "   • Go to https://upstash.com"
echo "   • Create Redis database (same region as Render)"
echo "   • Copy connection string: REDIS_URL=rediss://..."
echo ""
echo "4️⃣  Set up LiveKit:"
echo "   • Go to https://livekit.cloud"
echo "   • Create project"
echo "   • Save: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET"
echo ""
echo "5️⃣  Deploy Backend (Render):"
echo "   • Go to https://render.com"
echo "   • Create Web Service, connect GitHub"
echo "   • Set root: Dockerfile at apps/server/Dockerfile"
echo "   • Add all environment variables (see .env.production.example)"
echo "   • Deploy"
echo ""
echo "6️⃣  Deploy Frontend (Vercel):"
echo "   • Go to https://vercel.com"
echo "   • Import project from GitHub"
echo "   • Set NEXT_PUBLIC_API_URL=https://your-render-domain.com"
echo "   • Deploy"
echo ""
echo "7️⃣  Set up DNS (Cloudflare):"
echo "   • Go to https://cloudflare.com"
echo "   • Add your domain"
echo "   • Create CNAME for api → Render domain"
echo "   • Create CNAME for www → Vercel domain"
echo ""
echo -e "${GREEN}Full guide: BUDGET_DEPLOYMENT.md${NC}"
