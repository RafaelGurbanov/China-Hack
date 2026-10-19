/**
 * CampusBridge AI REST API (Express 5). Every route below /api except the
 * auth endpoints requires a valid session, and every query is scoped to the
 * session's user id. The browser never supplies a user id.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import {
  CURRENCIES,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PRIORITIES,
  RATE_SOURCE_LABEL,
  TRANSFER_ROUTES,
  addMonths,
  cleanText,
  compareTransfer,
  isCurrencyCode,
  localToday,
  parseAmount,
  validateDate,
  validateEmail,
  validatePassword,
} from '../shared/finance.js';
import { MAX_MESSAGE_LENGTH, describeProvider, handleMessage, listMessages, rulesProvider } from './assistant.js';
import {
  SESSION_COOKIE,
  clearedCookie,
  createLoginLimiter,
  createSession,
  csrfGuard,
  destroySession,
  dummyVerify,
  hashPassword,
  readCookie,
  sessionCookie,
  userForToken,
  verifyPassword,
} from './auth.js';
import { audit, clearWorkspace, ensureProfile, insertTransaction, mapAudit, mapTransaction, nowIso, seedSampleWorkspace, tx } from './db.js';
import { ACTION_TYPES, HttpError, buildSnapshot, confirmAction, listPendingActions, proposeAction, rejectAction, validateEntry } from './services.js';

const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

function fieldErrors(errors) {
  const first = Object.values(errors)[0];
  throw new HttpError(422, first, { fields: errors });
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {() => string} [opts.today]   calendar date provider (YYYY-MM-DD)
 * @param {boolean} [opts.secureCookies]
 * @param {number} [opts.sessionTtlHours]
 * @param {string[]} [opts.clientOrigins] extra allowed browser origins (dev server)
 * @param {string|null} [opts.clientDist] built frontend to serve, if any
 * @param {object} [opts.assistantProvider] request interpreter; defaults to the rules engine
 */
export function createApp({
  db,
  today = () => localToday(),
  secureCookies = false,
  sessionTtlHours = 12,
  clientOrigins = [],
  clientDist = null,
  loginLimiter = createLoginLimiter(),
  assistantProvider = rulesProvider,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // Security headers for API and static files.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  app.use(csrfGuard((req) => [`${req.protocol}://${req.get('host')}`, ...clientOrigins]));

  const ttlSeconds = sessionTtlHours * 3600;
  const startSession = (res, userId) => {
    const { token } = createSession(db, userId, sessionTtlHours);
    res.append('Set-Cookie', sessionCookie(token, { secure: secureCookies, maxAgeSeconds: ttlSeconds }));
  };

  // Attach the signed-in user (if any) from the session cookie.
  app.use('/api', (req, _res, next) => {
    req.user = userForToken(db, readCookie(req, SESSION_COOKIE));
    next();
  });
  const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in to continue.')));

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/meta', (_req, res) =>
    res.json({
      currencies: CURRENCIES,
      expenseCategories: EXPENSE_CATEGORIES,
      incomeCategories: INCOME_CATEGORIES,
      priorities: PRIORITIES,
      routes: TRANSFER_ROUTES.map(({ id, name, kind, goodFor }) => ({ id, name, kind, goodFor })),
      rateSource: RATE_SOURCE_LABEL,
      assistant: { ...describeProvider(assistantProvider), maxLength: MAX_MESSAGE_LENGTH },
      actionTypes: ACTION_TYPES,
    }),
  );

  app.post('/api/auth/register', async (req, res) => {
    const errors = {};
    const name = cleanText(req.body?.name, { field: 'Name', max: 60 });
    if (!name.ok) errors.name = name.error;
    const email = validateEmail(req.body?.email);
    if (!email.ok) errors.email = email.error;
    const pw = validatePassword(req.body?.password);
    if (!pw.ok) errors.password = pw.error;
    if (Object.keys(errors).length) fieldErrors(errors);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.value)) {
      fieldErrors({ email: 'An account with this email already exists. Sign in instead.' });
    }
    const hash = await hashPassword(pw.value);
    const userId = tx(db, () => {
      const id = Number(
        db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(email.value, name.value, hash, nowIso())
          .lastInsertRowid,
      );
      ensureProfile(db, id);
      if (req.body?.sampleData === true) seedSampleWorkspace(db, id, today());
      audit(db, { userId: id, action: 'auth.registered', entity: 'user', entityId: id, detail: { sampleData: req.body?.sampleData === true } });
      return id;
    });
    startSession(res, userId);
    res.status(201).json({ user: { id: userId, email: email.value, name: name.value } });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = validateEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email.ok || !password) fail(422, 'Enter your email and password.');
    const keys = [`ip:${req.ip}`, `email:${email.value}`];
    if (loginLimiter.blocked(keys)) fail(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
    const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email.value);
    const ok = row ? await verifyPassword(password.slice(0, 256), row.password_hash) : await dummyVerify(password.slice(0, 256));
    if (!ok) {
      loginLimiter.fail(keys);
      if (row)
        audit(db, {
          userId: row.id,
          actor: 'system',
          action: 'auth.login',
          entity: 'user',
          entityId: row.id,
          outcome: 'failed',
          detail: { reason: 'wrong password' },
        });
      fail(401, 'Email or password is incorrect.');
    }
    loginLimiter.reset(keys);
    startSession(res, row.id);
    audit(db, { userId: row.id, action: 'auth.login', entity: 'user', entityId: row.id });
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.user) audit(db, { userId: req.user.id, action: 'auth.logout', entity: 'user', entityId: req.user.id });
    destroySession(db, readCookie(req, SESSION_COOKIE));
    res.append('Set-Cookie', clearedCookie({ secure: secureCookies }));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => res.json({ user: req.user ?? null }));

  // -------------------------------------------------------------------------
  // Authenticated
  // -------------------------------------------------------------------------

  app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') ? next() : requireAuth(req, res, next)));

  app.get('/api/workspace', (req, res) => {
    res.json({ ...buildSnapshot(db, req.user.id, today()), pendingActions: listPendingActions(db, req.user.id) });
  });

  app.post('/api/workspace/sample', (req, res) => {
    if (req.body?.confirm !== true) fail(400, 'Confirmation required.');
    tx(db, () => {
      seedSampleWorkspace(db, req.user.id, today());
      audit(db, {
        userId: req.user.id,
        action: 'workspace.sample_loaded',
        entity: 'workspace',
        detail: { note: 'Replaced records with fictional sample data' },
      });
    });
    res.json({ ok: true });
  });

  app.post('/api/workspace/reset', (req, res) => {
    if (req.body?.confirm !== true) fail(400, 'Confirmation required.');
    tx(db, () => {
      clearWorkspace(db, req.user.id);
      audit(db, { userId: req.user.id, action: 'workspace.cleared', entity: 'workspace' });
    });
    res.json({ ok: true });
  });

  app.put('/api/profile', (req, res) => {
    const b = req.body ?? {};
    const errors = {};
    if (!isCurrencyCode(b.homeCurrency)) errors.homeCurrency = 'Choose a supported home currency.';
    if (!isCurrencyCode(b.studyCurrency)) errors.studyCurrency = 'Choose a supported study currency.';
    const support = parseAmount(b.monthlySupport, { field: 'Monthly support', max: 100_000, allowZero: true });
    if (!support.ok) errors.monthlySupport = support.error;
    const day = Number(b.supportDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) errors.supportDay = 'Support day must be a whole number from 1 to 28.';
    if (Object.keys(errors).length) fieldErrors(errors);
    db.prepare('UPDATE profiles SET home_currency = ?, study_currency = ?, monthly_support = ?, support_day = ? WHERE user_id = ?').run(
      b.homeCurrency,
      b.studyCurrency,
      support.value,
      day,
      req.user.id,
    );
    audit(db, {
      userId: req.user.id,
      action: 'profile.updated',
      entity: 'profile',
      detail: { homeCurrency: b.homeCurrency, studyCurrency: b.studyCurrency, monthlySupport: support.value, supportDay: day },
    });
    res.json({ ok: true });
  });

  app.put('/api/budgets', (req, res) => {
    const limits = req.body?.limits;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) fail(400, 'Send budget limits as { category: amount }.');
    const errors = {};
    const clean = {};
    for (const [cat, raw] of Object.entries(limits)) {
      if (!EXPENSE_CATEGORIES.includes(cat)) {
        errors[cat] = 'Unknown category.';
        continue;
      }
      const r = parseAmount(raw === '' || raw == null ? '0' : raw, { field: cat, max: 50_000, allowZero: true });
      if (!r.ok) errors[cat] = r.error;
      else clean[cat] = r.value;
    }
    if (Object.keys(errors).length) fieldErrors(errors);
    tx(db, () => {
      for (const [cat, v] of Object.entries(clean)) {
        if (v > 0)
          db.prepare(
            'INSERT INTO budgets (user_id, category, monthly_limit) VALUES (?, ?, ?) ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit',
          ).run(req.user.id, cat, v);
        else db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?').run(req.user.id, cat);
      }
      audit(db, { userId: req.user.id, action: 'budget.updated', entity: 'budget', detail: clean });
    });
    res.json({ ok: true });
  });

  // Transactions: income and expenses the user records. Simulated transfers and
  // savings contributions are created only through confirmed actions.
  app.post('/api/transactions', (req, res) => {
    const r = validateEntry(req.body, today());
    if (!r.ok) {
      audit(db, {
        userId: req.user.id,
        action: 'transaction.create',
        entity: 'transaction',
        outcome: 'validation_failed',
        detail: { fields: Object.keys(r.errors) },
      });
      fieldErrors(r.errors);
    }
    const id = insertTransaction(db, req.user.id, r.value);
    audit(db, {
      userId: req.user.id,
      action: `${r.value.type === 'expense' ? 'expense' : 'income'}.created`,
      entity: 'transaction',
      entityId: id,
      detail: { amount: r.value.amount, currency: r.value.currency, category: r.value.category },
    });
    res.status(201).json({ transaction: mapTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id)) });
  });

  const editable = (userId, id) => {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId);
    if (!row) fail(404, 'Transaction not found.');
    if (row.simulated || !['expense', 'income', 'opening_balance'].includes(row.type))
      fail(409, 'Simulated transfers and savings contributions are part of the audit trail and cannot be edited.');
    return row;
  };

  app.put('/api/transactions/:id', (req, res) => {
    const row = editable(req.user.id, req.params.id);
    const r = validateEntry(req.body, today());
    if (!r.ok) fieldErrors(r.errors);
    db.prepare(
      'UPDATE transactions SET type = ?, category = ?, description = ?, amount = ?, currency = ?, occurred_on = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ).run(r.value.type, r.value.category, r.value.description, r.value.amount, r.value.currency, r.value.occurredOn, nowIso(), row.id, req.user.id);
    audit(db, {
      userId: req.user.id,
      action: `${r.value.type === 'expense' ? 'expense' : 'income'}.updated`,
      entity: 'transaction',
      entityId: row.id,
      detail: { from: { amount: row.amount, currency: row.currency }, to: { amount: r.value.amount, currency: r.value.currency } },
    });
    res.json({ transaction: mapTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id)) });
  });

  app.delete('/api/transactions/:id', (req, res) => {
    const row = editable(req.user.id, req.params.id);
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(row.id, req.user.id);
    audit(db, {
      userId: req.user.id,
      action: `${row.type === 'expense' ? 'expense' : 'income'}.deleted`,
      entity: 'transaction',
      entityId: row.id,
      detail: { amount: row.amount, currency: row.currency, description: row.description },
    });
    res.json({ ok: true });
  });

  app.put('/api/savings-goal', (req, res) => {
    const b = req.body ?? {};
    const errors = {};
    const name = cleanText(b.name, { field: 'Goal name', max: 60 });
    if (!name.ok) errors.name = name.error;
    const target = parseAmount(b.target, { field: 'Target', max: 500_000 });
    if (!target.ok) errors.target = target.error;
    if (!isCurrencyCode(b.currency)) errors.currency = 'Choose a supported currency.';
    const deadline = validateDate(b.deadline, { field: 'Deadline', today: today(), future: true });
    if (!deadline.ok) errors.deadline = deadline.error;
    const start = parseAmount(b.startingSaved ?? 0, { field: 'Starting savings', max: 500_000, allowZero: true });
    if (!start.ok) errors.startingSaved = start.error;
    const planned = parseAmount(b.plannedMonthly ?? 0, { field: 'Planned monthly saving', max: 100_000, allowZero: true });
    if (!planned.ok) errors.plannedMonthly = planned.error;
    if (Object.keys(errors).length) fieldErrors(errors);
    const existing = db.prepare('SELECT currency FROM savings_goals WHERE user_id = ?').get(req.user.id);
    const contributed = db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND type = 'savings_contribution'").get(req.user.id).n;
    if (existing && contributed > 0 && existing.currency !== b.currency)
      fail(409, `The goal already has contributions in ${existing.currency}, so its currency cannot change.`);
    db.prepare(
      `INSERT INTO savings_goals (user_id, name, target, currency, deadline, starting_saved, planned_monthly, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, target = excluded.target, currency = excluded.currency, deadline = excluded.deadline,
         starting_saved = excluded.starting_saved, planned_monthly = excluded.planned_monthly, updated_at = excluded.updated_at`,
    ).run(req.user.id, name.value, target.value, b.currency, deadline.value, start.value, planned.value, nowIso());
    audit(db, {
      userId: req.user.id,
      action: existing ? 'savings_goal.updated' : 'savings_goal.created',
      entity: 'savings_goal',
      detail: { target: target.value, currency: b.currency, deadline: deadline.value },
    });
    res.json({ ok: true });
  });

  app.post('/api/obligations', (req, res) => {
    const b = req.body ?? {};
    const errors = {};
    const name = cleanText(b.name, { field: 'Name' });
    if (!name.ok) errors.name = name.error;
    if (!EXPENSE_CATEGORIES.includes(b.category)) errors.category = 'Choose a category.';
    const amount = parseAmount(b.amount, { field: 'Amount', max: 500_000 });
    if (!amount.ok) errors.amount = amount.error;
    if (!isCurrencyCode(b.currency)) errors.currency = 'Choose a supported currency.';
    const due = validateDate(b.dueOn, { field: 'Due date', today: today(), notBefore: today() });
    if (!due.ok) errors.dueOn = due.error;
    if (!['monthly', 'once'].includes(b.recurring)) errors.recurring = 'Choose monthly or one-off.';
    if (Object.keys(errors).length) fieldErrors(errors);
    const id = Number(
      db
        .prepare('INSERT INTO obligations (user_id, name, category, amount, currency, due_on, recurring) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user.id, name.value, b.category, amount.value, b.currency, due.value, b.recurring).lastInsertRowid,
    );
    audit(db, {
      userId: req.user.id,
      action: 'obligation.created',
      entity: 'obligation',
      entityId: id,
      detail: { amount: amount.value, currency: b.currency, dueOn: due.value },
    });
    res.status(201).json({ id });
  });

  const ownedObligation = (userId, id) =>
    db.prepare('SELECT * FROM obligations WHERE id = ? AND user_id = ?').get(Number(id) || 0, userId) ?? fail(404, 'Bill not found.');

  app.delete('/api/obligations/:id', (req, res) => {
    const row = ownedObligation(req.user.id, req.params.id);
    db.prepare('DELETE FROM obligations WHERE id = ? AND user_id = ?').run(row.id, req.user.id);
    audit(db, { userId: req.user.id, action: 'obligation.deleted', entity: 'obligation', entityId: row.id, detail: { name: row.name } });
    res.json({ ok: true });
  });

  /** Record a bill as paid: adds the expense and moves a monthly bill to next month. */
  app.post('/api/obligations/:id/pay', (req, res) => {
    const row = ownedObligation(req.user.id, req.params.id);
    const txId = tx(db, () => {
      const id = insertTransaction(db, req.user.id, {
        type: 'expense',
        category: row.category,
        description: row.name,
        amount: row.amount,
        currency: row.currency,
        occurredOn: today(),
      });
      if (row.recurring === 'monthly') db.prepare('UPDATE obligations SET due_on = ? WHERE id = ?').run(addMonths(row.due_on, 1), row.id);
      else db.prepare('DELETE FROM obligations WHERE id = ?').run(row.id);
      audit(db, {
        userId: req.user.id,
        action: 'obligation.paid',
        entity: 'obligation',
        entityId: row.id,
        detail: { expenseId: id, amount: row.amount, currency: row.currency },
      });
      return id;
    });
    res.json({ transactionId: txId });
  });

  app.post('/api/transfers/quote', (req, res) => {
    const b = req.body ?? {};
    const amount = parseAmount(b.amount, { field: 'Amount', max: 1_000_000 });
    if (!amount.ok) fail(422, amount.error);
    if (!isCurrencyCode(b.from) || !isCurrencyCode(b.to)) fail(422, 'Choose supported currencies.');
    if (b.from === b.to) fail(422, 'Source and destination currencies must differ.');
    const priority = Object.hasOwn(PRIORITIES, b.priority) ? b.priority : 'max_received';
    res.json(compareTransfer({ amount: amount.value, from: b.from, to: b.to, priority }));
  });

  app.get('/api/actions', (req, res) => res.json({ actions: listPendingActions(db, req.user.id) }));

  app.post('/api/actions', (req, res) => {
    const type = String(req.body?.type ?? '');
    if (!ACTION_TYPES.includes(type)) fail(400, 'Unknown action type.');
    res.status(201).json({ action: proposeAction(db, req.user.id, type, req.body?.params ?? {}, { actor: 'user', today: today() }) });
  });

  app.post('/api/actions/:id/confirm', (req, res) => res.json({ action: confirmAction(db, req.user.id, req.params.id, { today: today() }) }));
  app.post('/api/actions/:id/reject', (req, res) => res.json({ action: rejectAction(db, req.user.id, req.params.id) }));

  app.get('/api/assistant/messages', (req, res) => res.json({ messages: listMessages(db, req.user.id) }));

  app.post('/api/assistant/messages', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') fail(400, 'Send your message as text.');
    await handleMessage(db, req.user, text, { today: today(), provider: assistantProvider });
    res.status(201).json({ messages: listMessages(db, req.user.id) });
  });

  app.delete('/api/assistant/messages', (req, res) => {
    db.prepare('DELETE FROM assistant_messages WHERE user_id = ?').run(req.user.id);
    db.prepare("UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE user_id = ? AND status = 'pending' AND initiated_by = 'assistant'").run(
      nowIso(),
      req.user.id,
    );
    audit(db, { userId: req.user.id, action: 'assistant.cleared', entity: 'conversation' });
    res.json({ ok: true });
  });

  app.get('/api/activity', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const rows = db.prepare('SELECT * FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
    res.json({ events: rows.map(mapAudit) });
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // Built frontend (production). In development Vite serves it and proxies /api here.
  if (clientDist && existsSync(join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
  }

  // Errors: known errors keep their message; anything else is logged and hidden.
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    console.error(`[${nowIso()}] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  return app;
}
