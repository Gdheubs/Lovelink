#!/usr/bin/env node
/**
 * =============================================================================
 * Loverlink Interactive Deployment Wizard
 * 
 * Guides you through the entire deployment process step-by-step.
 * Run with: npx tsx deployment-wizard.ts
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

interface DeploymentConfig {
  supabase: {
    databaseUrl: string;
    directUrl: string;
  };
  upstash: {
    redisUrl: string;
  };
  livekit: {
    url: string;
    apiKey: string;
    apiSecret: string;
  };
  render: {
    domain: string;
    accessTokenSecret: string;
    refreshTokenSecret: string;
  };
  vercel: {
    domain: string;
    apiUrl: string;
  };
  cloudflare: {
    domain: string;
  };
}

const question = (prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
};

const log = {
  success: (msg: string) => console.log(`\n✅ ${msg}`),
  info: (msg: string) => console.log(`\nℹ️  ${msg}`),
  step: (msg: string) => console.log(`\n📍 ${msg}`),
  error: (msg: string) => console.log(`\n❌ ${msg}`),
  section: (title: string) => console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`),
};

async function getConfig(): Promise<DeploymentConfig> {
  const config: DeploymentConfig = {
    supabase: { databaseUrl: '', directUrl: '' },
    upstash: { redisUrl: '' },
    livekit: { url: '', apiKey: '', apiSecret: '' },
    render: { domain: '', accessTokenSecret: '', refreshTokenSecret: '' },
    vercel: { domain: '', apiUrl: '' },
    cloudflare: { domain: '' },
  };

  log.section('LOVERLINK DEPLOYMENT WIZARD');
  console.log('This wizard will guide you through deploying Loverlink.\n');

  // Supabase
  log.step('1️⃣  SUPABASE DATABASE (PostgreSQL)');
  console.log('Create project at: https://supabase.com\n');
  config.supabase.databaseUrl = await question('DATABASE_URL (Transaction Pooler): ');
  config.supabase.directUrl = await question('DATABASE_DIRECT_URL (Direct connection): ');

  // Upstash
  log.step('2️⃣  UPSTASH REDIS (Cache)');
  console.log('Create database at: https://upstash.com\n');
  config.upstash.redisUrl = await question('REDIS_URL (starts with rediss://): ');

  // LiveKit
  log.step('3️⃣  LIVEKIT CLOUD (Voice)');
  console.log('Create project at: https://livekit.cloud\n');
  config.livekit.url = await question('LIVEKIT_URL (wss://...): ');
  config.livekit.apiKey = await question('LIVEKIT_API_KEY: ');
  config.livekit.apiSecret = await question('LIVEKIT_API_SECRET (32+ chars): ');

  if (config.livekit.apiSecret.length < 32) {
    log.error('LIVEKIT_API_SECRET must be at least 32 characters!');
    process.exit(1);
  }

  // Render
  log.step('4️⃣  RENDER (Backend Hosting)');
  console.log('Deploy at: https://render.com\n');
  config.render.domain = await question('Render domain (e.g., loverlink-api.onrender.com): ');
  
  // Generate secrets
  const { randomBytes } = await import('crypto');
  config.render.accessTokenSecret = randomBytes(32).toString('hex');
  config.render.refreshTokenSecret = randomBytes(32).toString('hex');
  log.success(`Generated ACCESS_TOKEN_SECRET`);
  log.success(`Generated REFRESH_TOKEN_SECRET`);

  // Vercel
  log.step('5️⃣  VERCEL (Frontend)');
  console.log('Deploy at: https://vercel.com\n');
  config.vercel.domain = await question('Vercel domain (e.g., myapp.vercel.app): ');
  config.vercel.apiUrl = config.render.domain; // Default to Render domain

  // Cloudflare
  log.step('6️⃣  CLOUDFLARE (DNS)');
  console.log('Manage at: https://cloudflare.com\n');
  config.cloudflare.domain = await question('Your domain (e.g., yourdomain.com): ');

  return config;
}

async function generateEnvFile(config: DeploymentConfig): Promise<void> {
  const envContent = `# Loverlink Production Environment
# Generated: ${new Date().toISOString()}

NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database (Supabase)
DATABASE_URL=${config.supabase.databaseUrl}
DATABASE_DIRECT_URL=${config.supabase.directUrl}
DATABASE_SSL=true

# Persistence
PERSISTENCE=postgres
REALTIME_IN_PROCESS=true
PRESENCE_TTL_SECONDS=45
PRESENCE_REAP_INTERVAL_SECONDS=15

# Redis (Upstash)
REDIS_URL=${config.upstash.redisUrl}

# LiveKit
LIVEKIT_URL=${config.livekit.url}
LIVEKIT_API_KEY=${config.livekit.apiKey}
LIVEKIT_API_SECRET=${config.livekit.apiSecret}

# HTTP
CORS_ORIGINS=https://${config.vercel.domain}
PUBLIC_WEB_URL=https://${config.vercel.domain}
TRUST_PROXY=true

# Authentication
ACCESS_TOKEN_SECRET=${config.render.accessTokenSecret}
REFRESH_TOKEN_SECRET=${config.render.refreshTokenSecret}
`;

  const envPath = path.join(process.cwd(), '.env.production');
  fs.writeFileSync(envPath, envContent);
  log.success(`Environment file created: .env.production`);
}

function generateDeploymentChecklist(config: DeploymentConfig): void {
  const checklist = `# Deployment Checklist

## ✅ Services Created

- [ ] Supabase project created
  - Database URL: ${config.supabase.databaseUrl.substring(0, 50)}...
  - Direct URL: ${config.supabase.directUrl.substring(0, 50)}...

- [ ] Upstash Redis created
  - Redis URL: ${config.upstash.redisUrl.substring(0, 50)}...

- [ ] LiveKit Cloud project created
  - LiveKit URL: ${config.livekit.url}
  - API Key: ${config.livekit.apiKey.substring(0, 20)}...

- [ ] Render Web Service created
  - Domain: ${config.render.domain}

- [ ] Vercel project deployed
  - Domain: ${config.vercel.domain}

- [ ] Cloudflare DNS configured
  - Domain: ${config.cloudflare.domain}

## 🚀 Next Steps

1. Run migrations:
   \`\`\`bash
   export DATABASE_DIRECT_URL='${config.supabase.directUrl}'
   export DATABASE_SSL=true
   npm run migrate --workspace=@loverlink/server
   \`\`\`

2. Verify Supabase:
   \`\`\`sql
   SELECT COUNT(*) FROM schema_migrations;  -- should be 5
   SELECT extname FROM pg_extension WHERE extname = 'vector';  -- should exist
   \`\`\`

3. Deploy to Render:
   - Copy .env.production content
   - Add to Render Environment Variables
   - Manual Deploy

4. Set up DNS in Cloudflare:
   - CNAME api → ${config.render.domain}
   - CNAME www → ${config.vercel.domain}

5. Test:
   - Frontend: https://${config.vercel.domain}
   - Backend: https://api.${config.cloudflare.domain}/healthz

## 📞 Support

- Render issues: https://docs.render.com
- Supabase issues: https://supabase.com/docs
- Vercel issues: https://vercel.com/docs
- See PRODUCTION_DEPLOYMENT.md for detailed guide
`;

  const checklistPath = path.join(process.cwd(), 'DEPLOYMENT_DONE.md');
  fs.writeFileSync(checklistPath, checklist);
  log.success(`Deployment checklist: DEPLOYMENT_DONE.md`);
}

async function main() {
  try {
    const config = await getConfig();
    
    log.section('SUMMARY');
    console.log(`
Database:  Supabase
Cache:     Upstash
Voice:     LiveKit
Backend:   Render (${config.render.domain})
Frontend:  Vercel (${config.vercel.domain})
Domain:    ${config.cloudflare.domain}
    `);

    const confirm = await question('\nProceed with deployment? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes') {
      console.log('Deployment cancelled.');
      rl.close();
      process.exit(0);
    }

    await generateEnvFile(config);
    generateDeploymentChecklist(config);

    log.section('✅ DEPLOYMENT CONFIGURED');
    console.log(`
Your deployment configuration is ready!

📁 Files created:
   - .env.production (deployment secrets)
   - DEPLOYMENT_DONE.md (next steps checklist)

📚 Full guide:
   - See PRODUCTION_DEPLOYMENT.md for detailed instructions

🚀 Next steps:
   1. Review .env.production for correctness
   2. Add environment variables to Render dashboard
   3. Run database migrations
   4. Set up DNS records in Cloudflare
   5. Monitor deployment logs

Good luck! 🎉
    `);

    rl.close();
  } catch (error) {
    log.error(`${error instanceof Error ? error.message : 'Unknown error'}`);
    rl.close();
    process.exit(1);
  }
}

main();
