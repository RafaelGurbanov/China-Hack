/**
 * Server entry point. Configuration comes from environment variables (see
 * .env.example); nothing secret is hard-coded or sent to the browser.
 *
 *   node --env-file-if-exists=.env server/index.js [--reset-demo] [--seed-only]
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { createClaudeProvider, rulesProvider } from './assistant.js';
import { hashPassword } from './auth.js';
import { DEMO_ACCOUNT, audit, ensureProfile, nowIso, openDatabase, seedSampleWorkspace, tx } from './db.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const production = env.NODE_ENV === 'production';
const port = Number(env.PORT) || 8787;
const dbPath = resolve(root, env.DATABASE_PATH || 'data/campusbridge.db');

const db = openDatabase(dbPath);

/** Create (or refresh with --reset-demo) the fictional demo account. */
async function ensureDemoAccount(reset) {
  if (env.SEED_DEMO === 'false') return;
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_ACCOUNT.email);
  if (!user) {
    const hash = await hashPassword(DEMO_ACCOUNT.password);
    const id = Number(
      db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(DEMO_ACCOUNT.email, DEMO_ACCOUNT.name, hash, nowIso())
        .lastInsertRowid,
    );
    user = { id };
    reset = true;
  }
  if (reset) {
    tx(db, () => {
      ensureProfile(db, user.id);
      seedSampleWorkspace(db, user.id);
      audit(db, {
        userId: user.id,
        actor: 'system',
        action: 'workspace.sample_loaded',
        entity: 'workspace',
        detail: { note: 'Demo account seeded with fictional data' },
      });
    });
    console.log(`Demo account ready: ${DEMO_ACCOUNT.email} (fictional sample data)`);
  }
}

await ensureDemoAccount(process.argv.includes('--reset-demo'));
if (process.argv.includes('--seed-only')) {
  db.close();
  process.exit(0);
}

// Optional: with ANTHROPIC_API_KEY set, Claude interprets requests and the rules engine
// remains the automatic fallback. Without it, everything runs on the rules engine.
const assistantProvider =
  createClaudeProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ASSISTANT_MODEL || undefined,
    timeoutMs: Number(env.ASSISTANT_TIMEOUT_MS) || undefined,
  }) ?? rulesProvider;
console.log(`Assistant interpretation: ${assistantProvider.label}`);

const app = createApp({
  db,
  assistantProvider,
  secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
  sessionTtlHours: Number(env.SESSION_TTL_HOURS) || 12,
  clientOrigins: (env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  clientDist: resolve(root, 'dist'),
});

const server = app.listen(port, env.HOST || '127.0.0.1', () => {
  console.log(`CampusBridge AI API listening on http://${env.HOST || '127.0.0.1'}:${port}  (database: ${dbPath})`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
