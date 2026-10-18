/**
 * Data layer: SQLite through Node's built-in `node:sqlite` module (no native
 * add-ons to compile). Every table that holds financial records carries a
 * user_id, and every query in this project filters by the user id taken from
 * the verified session, never from the request body.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addDays, addMonths, compareTransfer, localToday, round2 } from '../shared/finance.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS profiles (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_currency   TEXT NOT NULL DEFAULT 'AZN',
  study_currency  TEXT NOT NULL DEFAULT 'EUR',
  monthly_support REAL NOT NULL DEFAULT 0,
  support_day     INTEGER NOT NULL DEFAULT 1,
  sample_data     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS budgets (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  monthly_limit REAL NOT NULL,
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('opening_balance','income','expense','transfer_out','transfer_in','savings_contribution')),
  category    TEXT,
  description TEXT NOT NULL,
  amount      REAL NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  simulated   INTEGER NOT NULL DEFAULT 0,
  ref         TEXT,
  created_by  TEXT NOT NULL DEFAULT 'user',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, occurred_on);
CREATE TABLE IF NOT EXISTS savings_goals (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  target          REAL NOT NULL,
  currency        TEXT NOT NULL,
  deadline        TEXT NOT NULL,
  starting_saved  REAL NOT NULL DEFAULT 0,
  planned_monthly REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS obligations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL,
  amount    REAL NOT NULL CHECK (amount > 0),
  currency  TEXT NOT NULL,
  due_on    TEXT NOT NULL,
  recurring TEXT NOT NULL CHECK (recurring IN ('monthly','once'))
);
CREATE INDEX IF NOT EXISTS obligations_user ON obligations(user_id, due_on);
CREATE TABLE IF NOT EXISTS transfer_simulations (
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id         TEXT NOT NULL,
  route_name       TEXT NOT NULL,
  send_amount      REAL NOT NULL,
  send_currency    TEXT NOT NULL,
  fee              REAL NOT NULL,
  rate             REAL NOT NULL,
  receive_amount   REAL NOT NULL,
  receive_currency TEXT NOT NULL,
  delivery_label   TEXT NOT NULL,
  initiated_by     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sims_user ON transfer_simulations(user_id, created_at);
CREATE TABLE IF NOT EXISTS pending_actions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  params       TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired','failed')),
  result       TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS actions_user ON pending_actions(user_id, status);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user ON assistant_messages(user_id, id);
CREATE TABLE IF NOT EXISTS audit_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id TEXT,
  outcome   TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_events(user_id, id);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

/** Run `fn` inside a transaction; rolls back on any error. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case rows -> camelCase objects for the API)
// ---------------------------------------------------------------------------

export const mapTransaction = (r) => ({
  id: r.id,
  type: r.type,
  category: r.category,
  description: r.description,
  amount: r.amount,
  currency: r.currency,
  occurredOn: r.occurred_on,
  simulated: Boolean(r.simulated),
  ref: r.ref,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export const mapProfile = (r) => ({
  homeCurrency: r.home_currency,
  studyCurrency: r.study_currency,
  monthlySupport: r.monthly_support,
  supportDay: r.support_day,
  sampleData: Boolean(r.sample_data),
});
export const mapGoal = (r) =>
  r
    ? {
        name: r.name,
        target: r.target,
        currency: r.currency,
        deadline: r.deadline,
        startingSaved: r.starting_saved,
        plannedMonthly: r.planned_monthly,
        updatedAt: r.updated_at,
      }
    : null;
export const mapObligation = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  amount: r.amount,
  currency: r.currency,
  dueOn: r.due_on,
  recurring: r.recurring,
});
export const mapSimulation = (r) => ({
  id: r.id,
  routeId: r.route_id,
  routeName: r.route_name,
  sendAmount: r.send_amount,
  sendCurrency: r.send_currency,
  fee: r.fee,
  rate: r.rate,
  receiveAmount: r.receive_amount,
  receiveCurrency: r.receive_currency,
  deliveryLabel: r.delivery_label,
  initiatedBy: r.initiated_by,
  createdAt: r.created_at,
  status: 'simulated',
});
export const mapAudit = (r) => ({
  id: r.id,
  ts: r.ts,
  actor: r.actor,
  action: r.action,
  entity: r.entity,
  entityId: r.entity_id,
  outcome: r.outcome,
  detail: r.detail ? JSON.parse(r.detail) : null,
});

// ---------------------------------------------------------------------------
// Audit log. Never pass passwords, tokens or raw messages in `detail`.
// ---------------------------------------------------------------------------

export function audit(db, { userId = null, actor = 'user', action, entity = null, entityId = null, outcome = 'success', detail = null }) {
  db.prepare('INSERT INTO audit_events (user_id, ts, actor, action, entity, entity_id, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    userId,
    nowIso(),
    actor,
    action,
    entity,
    entityId == null ? null : String(entityId),
    outcome,
    detail ? JSON.stringify(detail) : null,
  );
}

export function insertTransaction(db, userId, t) {
  const ts = nowIso();
  const res = db
    .prepare(
      `INSERT INTO transactions (user_id, type, category, description, amount, currency, occurred_on, simulated, ref, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      t.type,
      t.category ?? null,
      t.description,
      round2(t.amount),
      t.currency,
      t.occurredOn,
      t.simulated ? 1 : 0,
      t.ref ?? null,
      t.createdBy ?? 'user',
      ts,
      ts,
    );
  return Number(res.lastInsertRowid);
}

export function ensureProfile(db, userId) {
  db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(userId);
}

/** Remove every financial record of one user (keeps the account, sessions and audit history). */
export function clearWorkspace(db, userId) {
  for (const table of ['budgets', 'transactions', 'savings_goals', 'obligations', 'transfer_simulations', 'pending_actions', 'assistant_messages']) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
  db.prepare("UPDATE profiles SET home_currency = 'AZN', study_currency = 'EUR', monthly_support = 0, support_day = 1, sample_data = 0 WHERE user_id = ?").run(
    userId,
  );
}

// ---------------------------------------------------------------------------
// Fictional demonstration data
// ---------------------------------------------------------------------------

export const DEMO_ACCOUNT = { email: 'demo@campusbridge.test', name: 'Aylin (demo)', password: 'CampusBridge-demo-2026' };

/**
 * Fill one user's workspace with a FICTIONAL Azerbaijani student in Germany:
 * family support in AZN, costs in EUR, three months of history, simulated
 * monthly AZN→EUR transfers through the illustrative routes. Dates are relative
 * to `today` so the demo always looks current.
 */
export function seedSampleWorkspace(db, userId, today = localToday()) {
  clearWorkspace(db, userId);
  db.prepare(
    "UPDATE profiles SET home_currency = 'AZN', study_currency = 'EUR', monthly_support = 1200, support_day = 1, sample_data = 1 WHERE user_id = ?",
  ).run(userId);

  const budgets = {
    Housing: 450,
    'Food & groceries': 230,
    Transport: 60,
    Education: 40,
    'Health & insurance': 125,
    'Phone & internet': 20,
    Leisure: 80,
    Other: 40,
  };
  const putBudget = db.prepare('INSERT INTO budgets (user_id, category, monthly_limit) VALUES (?, ?, ?)');
  for (const [c, v] of Object.entries(budgets)) putBudget.run(userId, c, v);

  const startMonth = addMonths(`${today.slice(0, 7)}-01`, -3);
  const add = (t) => (t.occurredOn <= today ? insertTransaction(db, userId, { createdBy: 'seed', ...t }) : null);
  add({ type: 'opening_balance', category: 'Opening balance', description: 'Opening balance (sample)', amount: 1200, currency: 'AZN', occurredOn: startMonth });
  add({ type: 'opening_balance', category: 'Opening balance', description: 'Opening balance (sample)', amount: 900, currency: 'EUR', occurredOn: startMonth });

  const groceries = [
    [3, 46.8, 'Supermarket'],
    [9, 38.2, 'Supermarket'],
    [14, 52.4, 'Weekly shop'],
    [21, 41.1, 'Supermarket'],
    [27, 29.9, 'Bakery and market'],
  ];
  const sims = db.prepare(
    `INSERT INTO transfer_simulations (id, user_id, route_id, route_name, send_amount, send_currency, fee, rate, receive_amount, receive_currency, delivery_label, initiated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i <= 3; i += 1) {
    const m = addMonths(startMonth, i);
    const on = (day) => `${m.slice(0, 8)}${String(day).padStart(2, '0')}`;
    add({ type: 'income', category: 'Family support', description: 'Monthly support from family', amount: 1200, currency: 'AZN', occurredOn: on(1) });
    if (on(2) <= today) {
      const q = compareTransfer({ amount: 1150, from: 'AZN', to: 'EUR' }).quotes.find((x) => x.routeId === 'demo-online-transfer');
      const id = `SIM-${randomBytes(4).toString('hex').toUpperCase()}`;
      sims.run(
        id,
        userId,
        q.routeId,
        q.routeName,
        q.sendAmount,
        'AZN',
        q.fee,
        q.rate,
        q.receiveAmount,
        'EUR',
        q.deliveryLabel,
        'seed',
        `${on(2)}T09:00:00.000Z`,
      );
      add({
        type: 'transfer_out',
        category: 'Simulated transfer',
        description: `Simulated transfer ${id} via ${q.routeName}`,
        amount: q.sendAmount,
        currency: 'AZN',
        occurredOn: on(2),
        simulated: true,
        ref: id,
      });
      add({
        type: 'transfer_in',
        category: 'Simulated transfer',
        description: `Simulated transfer ${id} received`,
        amount: q.receiveAmount,
        currency: 'EUR',
        occurredOn: on(2),
        simulated: true,
        ref: id,
      });
    }
    add({ type: 'expense', category: 'Housing', description: 'Rent, shared flat', amount: 450, currency: 'EUR', occurredOn: on(1) });
    add({ type: 'expense', category: 'Health & insurance', description: 'Student health insurance', amount: 125, currency: 'EUR', occurredOn: on(1) });
    add({ type: 'expense', category: 'Transport', description: 'Monthly transport pass', amount: 49, currency: 'EUR', occurredOn: on(2) });
    add({ type: 'expense', category: 'Phone & internet', description: 'Mobile plan', amount: 15, currency: 'EUR', occurredOn: on(5) });
    for (const [d, amt, label] of groceries)
      add({ type: 'expense', category: 'Food & groceries', description: label, amount: round2(amt + i * 1.5), currency: 'EUR', occurredOn: on(d) });
    add({
      type: 'expense',
      category: 'Leisure',
      description: i % 2 ? 'Cinema with friends' : 'Museum and café',
      amount: i % 2 ? 24 : 31.5,
      currency: 'EUR',
      occurredOn: on(17),
    });
    add({ type: 'expense', category: 'Education', description: 'Course books', amount: i === 1 ? 64 : 18.9, currency: 'EUR', occurredOn: on(11) });
    add({ type: 'income', category: 'Part-time job', description: 'Library assistant (part-time)', amount: 450, currency: 'EUR', occurredOn: on(25) });
    add({ type: 'savings_contribution', category: 'Tuition savings', description: 'Monthly tuition saving', amount: 250, currency: 'EUR', occurredOn: on(26) });
    if (i === 3)
      add({
        type: 'expense',
        category: 'Other',
        description: 'Phone charger (paid in AZN while visiting home)',
        amount: 34,
        currency: 'AZN',
        occurredOn: on(12),
      });
  }

  const deadline = `${addMonths(today, 5).slice(0, 8)}15`;
  db.prepare(
    'INSERT INTO savings_goals (user_id, name, target, currency, deadline, starting_saved, planned_monthly, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, 'Summer semester tuition', 4500, 'EUR', deadline, 2000, 250, nowIso());

  const nextFirst = addMonths(`${today.slice(0, 7)}-01`, 1);
  const putOb = db.prepare('INSERT INTO obligations (user_id, name, category, amount, currency, due_on, recurring) VALUES (?, ?, ?, ?, ?, ?, ?)');
  putOb.run(userId, 'Rent, shared flat', 'Housing', 450, 'EUR', nextFirst, 'monthly');
  putOb.run(userId, 'Student health insurance', 'Health & insurance', 125, 'EUR', nextFirst, 'monthly');
  putOb.run(userId, 'Semester contribution', 'Education', 320, 'EUR', addDays(today, 40), 'once');
  putOb.run(userId, 'Mobile plan', 'Phone & internet', 15, 'EUR', `${addMonths(today, today.slice(8) >= '05' ? 1 : 0).slice(0, 8)}05`, 'monthly');
}
