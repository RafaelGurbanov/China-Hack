/**
 * Workspace service: builds each user's financial snapshot from stored data
 * and runs the sandbox action workflow (propose -> confirm/reject -> execute
 * -> record). The server re-validates every action at confirmation time, so a
 * modified browser cannot skip validation, confirmation or ownership checks.
 */
import { randomBytes } from 'node:crypto';
import {
  EXPENSE_CATEGORIES,
  RATE_SOURCE_LABEL,
  TRANSFER_ROUTES,
  cleanText,
  compareTransfer,
  convert,
  endOfMonthForecast,
  formatMoney,
  isCurrencyCode,
  localToday,
  monthKey,
  monthlySpending,
  parseAmount,
  round2,
  savingsPlan,
  spendingTrend,
  totalIn,
  upcomingObligations,
  validateDate,
  walletBalances,
  addDays,
  addMonths,
} from '../shared/finance.js';
import { audit, insertTransaction, mapGoal, mapObligation, mapProfile, mapSimulation, mapTransaction, nowIso, tx } from './db.js';

export const ACTION_TTL_MINUTES = 15;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function loadRecords(db, userId) {
  const profile = mapProfile(db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId));
  const budgets = db
    .prepare('SELECT category, monthly_limit FROM budgets WHERE user_id = ?')
    .all(userId)
    .map((r) => ({ category: r.category, monthlyLimit: r.monthly_limit }));
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY occurred_on DESC, id DESC').all(userId).map(mapTransaction);
  const goal = mapGoal(db.prepare('SELECT * FROM savings_goals WHERE user_id = ?').get(userId));
  const obligations = db.prepare('SELECT * FROM obligations WHERE user_id = ? ORDER BY due_on').all(userId).map(mapObligation);
  const simulations = db.prepare('SELECT * FROM transfer_simulations WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(mapSimulation);
  return { profile, budgets, transactions, goal, obligations, simulations };
}

/** Everything the interface and the assistant need, computed from stored records only. */
export function buildSnapshot(db, userId, today = localToday()) {
  const rec = loadRecords(db, userId);
  const cur = rec.profile.studyCurrency;
  const month = monthKey(today);
  const balances = walletBalances(rec.transactions, today);
  const contributions = rec.transactions.filter((t) => t.type === 'savings_contribution');
  const spending = monthlySpending(rec.transactions, rec.budgets, month, cur);
  const savings = savingsPlan(rec.goal, contributions, today);
  // Last month, in full and up to the same day of the month (for a fair comparison).
  const prevMonthEnd = addDays(`${month}-01`, -1);
  const prevMonth = monthKey(prevMonthEnd);
  const prevSameDay = `${prevMonth}-${String(Math.min(Number(today.slice(8, 10)), Number(prevMonthEnd.slice(8, 10)))).padStart(2, '0')}`;
  const spendingPrev = monthlySpending(rec.transactions, rec.budgets, prevMonth, cur);
  const spendingPrevToDate = monthlySpending(
    rec.transactions.filter((t) => t.occurredOn <= prevSameDay),
    rec.budgets,
    prevMonth,
    cur,
  );
  // Total available at the end of each of the last five months, then today.
  const balanceHistory = [];
  for (let i = 5; i >= 1; i -= 1) {
    const end = addDays(`${monthKey(addMonths(`${month}-01`, -i + 1))}-01`, -1);
    balanceHistory.push({ date: end, total: totalIn(walletBalances(rec.transactions, end), cur) });
  }
  balanceHistory.push({ date: today, total: totalIn(balances, cur) });
  // Corridors you have simulated, for the Money Atlas.
  const corridorMap = new Map();
  for (const s of rec.simulations) {
    const key = `${s.sendCurrency}-${s.receiveCurrency}`;
    const c = corridorMap.get(key) ?? { from: s.sendCurrency, to: s.receiveCurrency, count: 0, sent: 0, received: 0, fees: 0, last: null };
    c.count += 1;
    c.sent = round2(c.sent + s.sendAmount);
    c.received = round2(c.received + s.receiveAmount);
    c.fees = round2(c.fees + s.fee);
    if (!c.last || s.createdAt > c.last) c.last = s.createdAt;
    corridorMap.set(key, c);
  }
  const corridors = [...corridorMap.values()];
  const thisMonth = rec.transactions.filter((t) => monthKey(t.occurredOn) === month && t.occurredOn <= today);
  const incomeThisMonth = round2(thisMonth.filter((t) => t.type === 'income').reduce((a, t) => a + convert(t.amount, t.currency, cur), 0));
  return {
    today,
    rateSource: RATE_SOURCE_LABEL,
    ...rec,
    computed: {
      currency: cur,
      month,
      balances: Object.entries(balances)
        .filter(([, v]) => Math.abs(v) >= 0.005)
        .map(([currency, amount]) => ({ currency, amount, inStudyCurrency: convert(amount, currency, cur) }))
        .sort((a, b) => b.inStudyCurrency - a.inStudyCurrency),
      totalAvailable: totalIn(balances, cur),
      monthlySupport: {
        amount: rec.profile.monthlySupport,
        currency: rec.profile.homeCurrency,
        inStudyCurrency: convert(rec.profile.monthlySupport, rec.profile.homeCurrency, cur),
      },
      incomeThisMonth,
      spending,
      trend: spendingTrend(rec.transactions, month, cur, 6),
      spendingPrev,
      spendingPrevToDate,
      balanceHistory,
      monthChange: round2(totalIn(balances, cur) - (balanceHistory.at(-2)?.total ?? 0)),
      corridors,
      savings,
      forecast: endOfMonthForecast({ balances, currency: cur, today, profile: rec.profile, spending, obligations: rec.obligations }),
      upcoming: upcomingObligations(rec.obligations, savings, today, 60),
    },
  };
}

export function walletBalance(db, userId, currency, today = localToday()) {
  const rows = db.prepare('SELECT type, amount, currency, occurred_on FROM transactions WHERE user_id = ? AND currency = ?').all(userId, currency);
  return (
    walletBalances(
      rows.map((r) => ({ type: r.type, amount: r.amount, currency: r.currency, occurredOn: r.occurred_on })),
      today,
    )[currency] ?? 0
  );
}

// ---------------------------------------------------------------------------
// Validation of user-entered records (used by REST routes and the assistant)
// ---------------------------------------------------------------------------

/** Validate an income or expense entry. Returns { ok, value } or { ok: false, errors }. */
export function validateEntry(body, today) {
  const errors = {};
  const type = body?.type;
  if (type !== 'expense' && type !== 'income') errors.type = 'Choose expense or income.';
  const amount = parseAmount(body?.amount, { field: 'Amount', max: 50_000 });
  if (!amount.ok) errors.amount = amount.error;
  if (!isCurrencyCode(body?.currency)) errors.currency = 'Choose a supported currency.';
  const categories = type === 'income' ? ['Family support', 'Part-time job', 'Scholarship', 'Opening balance', 'Other income'] : EXPENSE_CATEGORIES;
  if (!categories.includes(body?.category)) errors.category = 'Choose a category from the list.';
  const desc = cleanText(body?.description, { field: 'Description' });
  if (!desc.ok) errors.description = desc.error;
  const date = validateDate(body?.occurredOn, { field: 'Date', today, notBefore: addDays(today, -730) });
  if (!date.ok) errors.occurredOn = date.error;
  else if (date.value > today) errors.occurredOn = 'Date cannot be in the future.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: type === 'income' && body.category === 'Opening balance' ? 'opening_balance' : type,
      amount: amount.value,
      currency: body.currency,
      category: body.category,
      description: desc.value,
      occurredOn: date.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox actions
// ---------------------------------------------------------------------------

const newId = (prefix, bytes = 6) => `${prefix}${randomBytes(bytes).toString('hex').toUpperCase()}`;

/**
 * Each action type: validate(params) -> { ok, value | error }, preview(value) and
 * execute(value) inside a database transaction. `ctx` = { db, userId, today }.
 */
const ACTIONS = {
  simulate_transfer: {
    label: 'Simulated transfer',
    validate(p, { db, userId, today }) {
      const amount = parseAmount(p?.amount, { field: 'Amount', max: 1_000_000 });
      if (!amount.ok) return { ok: false, error: amount.error };
      if (!isCurrencyCode(p?.from) || !isCurrencyCode(p?.to)) return { ok: false, error: 'Choose supported source and destination currencies.' };
      if (p.from === p.to) return { ok: false, error: 'Source and destination currencies must differ.' };
      const route = TRANSFER_ROUTES.find((r) => r.id === p?.routeId);
      if (!route) return { ok: false, error: 'Unknown transfer route.' };
      const quote = compareTransfer({ amount: amount.value, from: p.from, to: p.to }).quotes.find((q) => q.routeId === route.id);
      if (!quote.eligible) return { ok: false, error: quote.ineligibleReason };
      const balance = walletBalance(db, userId, p.from, today);
      if (balance < quote.sendAmount) {
        return {
          ok: false,
          error: `Your simulated ${p.from} wallet holds ${formatMoney(balance, p.from)}, which is less than ${formatMoney(quote.sendAmount, p.from)}.`,
        };
      }
      return { ok: true, value: { routeId: route.id, amount: amount.value, from: p.from, to: p.to }, quote, balance };
    },
    preview(v, { quote, balance }) {
      return {
        title: `Simulate sending ${formatMoney(quote.sendAmount, quote.sendCurrency)} via ${quote.routeName}`,
        rows: [
          ['Route', `${quote.routeName} (simulated)`],
          ['You send', formatMoney(quote.sendAmount, quote.sendCurrency)],
          ['Fee', formatMoney(quote.fee, quote.sendCurrency)],
          ['Illustrative rate', `1 ${quote.sendCurrency} = ${quote.rate.toFixed(4)} ${quote.receiveCurrency}`],
          ['Estimated to arrive', formatMoney(quote.receiveAmount, quote.receiveCurrency)],
          ['Estimated delivery', quote.deliveryLabel],
          [`${quote.sendCurrency} wallet after`, formatMoney(balance - quote.sendAmount, quote.sendCurrency)],
        ],
        highlight: formatMoney(quote.receiveAmount, quote.receiveCurrency),
        note: 'Sandbox only: this records a simulated transfer in your history. No money moves and no provider is contacted.',
      };
    },
    execute(v, { db, userId, today, quote, actor }) {
      const id = newId('SIM-', 4);
      db.prepare(
        `INSERT INTO transfer_simulations (id, user_id, route_id, route_name, send_amount, send_currency, fee, rate, receive_amount, receive_currency, delivery_label, initiated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        quote.routeId,
        quote.routeName,
        quote.sendAmount,
        quote.sendCurrency,
        quote.fee,
        quote.rate,
        quote.receiveAmount,
        quote.receiveCurrency,
        quote.deliveryLabel,
        actor,
        nowIso(),
      );
      const base = { category: 'Simulated transfer', occurredOn: today, simulated: true, ref: id, createdBy: actor };
      insertTransaction(db, userId, {
        ...base,
        type: 'transfer_out',
        description: `Simulated transfer ${id} via ${quote.routeName}`,
        amount: quote.sendAmount,
        currency: quote.sendCurrency,
      });
      insertTransaction(db, userId, {
        ...base,
        type: 'transfer_in',
        description: `Simulated transfer ${id} received`,
        amount: quote.receiveAmount,
        currency: quote.receiveCurrency,
      });
      return {
        entity: 'transfer_simulation',
        entityId: id,
        summary: `Simulated transfer ${id} recorded: ${formatMoney(quote.sendAmount, quote.sendCurrency)} → ${formatMoney(quote.receiveAmount, quote.receiveCurrency)} via ${quote.routeName}. No real money moved.`,
      };
    },
  },

  savings_contribution: {
    label: 'Tuition savings contribution',
    validate(p, { db, userId, today }) {
      const goal = db.prepare('SELECT * FROM savings_goals WHERE user_id = ?').get(userId);
      if (!goal) return { ok: false, error: 'Set up a tuition savings goal first.' };
      const amount = parseAmount(p?.amount, { field: 'Amount', max: 500_000 });
      if (!amount.ok) return { ok: false, error: amount.error };
      const currency = p?.currency ?? goal.currency;
      if (currency !== goal.currency)
        return { ok: false, error: `Contributions are made in the goal currency (${goal.currency}). Simulate a transfer to ${goal.currency} first.` };
      const balance = walletBalance(db, userId, currency, today);
      if (balance < amount.value)
        return {
          ok: false,
          error: `Your ${currency} wallet holds ${formatMoney(balance, currency)}, which is less than ${formatMoney(amount.value, currency)}.`,
        };
      return { ok: true, value: { amount: amount.value, currency }, goal, balance };
    },
    preview(v, { db, userId, today, balance }) {
      const before = buildSnapshot(db, userId, today).computed.savings;
      const after = round2(before.saved + v.amount);
      return {
        title: `Move ${formatMoney(v.amount, v.currency)} into ${before.name}`,
        rows: [
          ['From', `${v.currency} wallet (${formatMoney(balance, v.currency)} → ${formatMoney(balance - v.amount, v.currency)})`],
          ['Saved so far', `${formatMoney(before.saved, v.currency)} → ${formatMoney(after, v.currency)}`],
          ['Progress', `${Math.round(before.progress * 100)}% → ${Math.round(Math.min(1, after / before.target) * 100)}%`],
          ['Still to save after', formatMoney(Math.max(0, before.target - after), v.currency)],
        ],
        highlight: formatMoney(v.amount, v.currency),
        note: 'Moves money between your own CampusBridge records. Nothing is sent to a bank.',
      };
    },
    execute(v, { db, userId, today, actor }) {
      const id = insertTransaction(db, userId, {
        type: 'savings_contribution',
        category: 'Tuition savings',
        description: 'Tuition savings contribution',
        amount: v.amount,
        currency: v.currency,
        occurredOn: today,
        createdBy: actor,
      });
      return { entity: 'transaction', entityId: id, summary: `${formatMoney(v.amount, v.currency)} added to your tuition savings.` };
    },
  },

  add_expense: {
    label: 'New expense',
    validate(p, { today }) {
      const r = validateEntry({ ...p, type: 'expense' }, today);
      if (!r.ok) return { ok: false, error: Object.values(r.errors)[0] };
      return { ok: true, value: r.value };
    },
    preview(v, { db, userId, today }) {
      const snap = buildSnapshot(db, userId, today);
      const row = snap.computed.spending.rows.find((r) => r.category === v.category);
      const cur = snap.computed.currency;
      const add = monthKey(v.occurredOn) === snap.computed.month ? convert(v.amount, v.currency, cur) : 0;
      return {
        title: `Add expense: ${v.description}, ${formatMoney(v.amount, v.currency)}`,
        rows: [
          ['Category', v.category],
          ['Date', v.occurredOn],
          [
            'Amount',
            formatMoney(v.amount, v.currency) + (v.currency !== cur ? ` (≈ ${formatMoney(convert(v.amount, v.currency, cur), cur)}, illustrative rate)` : ''),
          ],
          [
            `${v.category} this month`,
            row.limit > 0
              ? `${formatMoney(row.spent, cur)} → ${formatMoney(row.spent + add, cur)} of ${formatMoney(row.limit, cur)}`
              : `${formatMoney(row.spent + add, cur)} (no budget set)`,
          ],
        ],
        highlight: formatMoney(v.amount, v.currency),
        note: 'Adds a record to your expense history.',
      };
    },
    execute(v, { db, userId, actor }) {
      const id = insertTransaction(db, userId, { ...v, createdBy: actor });
      return { entity: 'transaction', entityId: id, summary: `Expense "${v.description}" (${formatMoney(v.amount, v.currency)}) added to ${v.category}.` };
    },
  },
};

export const ACTION_TYPES = Object.keys(ACTIONS);

function actionView(row, preview) {
  return {
    id: row.id,
    type: row.type,
    label: ACTIONS[row.type]?.label ?? row.type,
    status: row.status,
    initiatedBy: row.initiated_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    preview: preview ?? null,
    result: row.result ? JSON.parse(row.result) : null,
  };
}

/** Validate and store a pending action. Nothing changes until it is confirmed. */
export function proposeAction(db, userId, type, params, { actor = 'user', today = localToday() } = {}) {
  const def = ACTIONS[type];
  if (!def) throw new HttpError(400, 'Unknown action type.');
  const ctx = { db, userId, today };
  const check = def.validate(params, ctx);
  if (!check.ok) {
    audit(db, { userId, actor, action: `${type}.proposed`, entity: 'action', outcome: 'validation_failed', detail: { reason: check.error } });
    throw new HttpError(422, check.error);
  }
  const preview = def.preview(check.value, { ...ctx, ...check });
  const id = newId('ACT-', 6);
  const created = nowIso();
  const expires = new Date(Date.now() + ACTION_TTL_MINUTES * 60_000).toISOString();
  db.prepare('INSERT INTO pending_actions (id, user_id, type, params, initiated_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    type,
    JSON.stringify(check.value),
    actor,
    'pending',
    created,
    expires,
  );
  audit(db, { userId, actor, action: `${type}.proposed`, entity: 'action', entityId: id, outcome: 'pending', detail: { preview: preview.title } });
  return actionView({ id, type, status: 'pending', initiated_by: actor, created_at: created, expires_at: expires }, preview);
}

function ownedPending(db, userId, id) {
  const row = db.prepare('SELECT * FROM pending_actions WHERE id = ? AND user_id = ?').get(String(id), userId);
  if (!row) throw new HttpError(404, 'Action not found.');
  if (row.status !== 'pending') throw new HttpError(409, `This action was already ${row.status}.`, { action: actionView(row) });
  if (row.expires_at < nowIso()) {
    db.prepare("UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE id = ?").run(nowIso(), row.id);
    audit(db, { userId, actor: 'system', action: `${row.type}.expired`, entity: 'action', entityId: row.id, outcome: 'expired' });
    throw new HttpError(410, `This proposal expired after ${ACTION_TTL_MINUTES} minutes. Ask again to get a fresh one.`);
  }
  return row;
}

function noteToAssistant(db, userId, row, body) {
  if (row.initiated_by !== 'assistant') return;
  db.prepare('INSERT INTO assistant_messages (user_id, role, body, created_at) VALUES (?, ?, ?, ?)').run(userId, 'assistant', JSON.stringify({ ...body, actionId: row.id }), nowIso());
}

/** Confirm: re-validate against current data, execute atomically, record the outcome. */
export function confirmAction(db, userId, id, { today = localToday() } = {}) {
  const row = ownedPending(db, userId, id);
  const def = ACTIONS[row.type];
  const params = JSON.parse(row.params);
  const ctx = { db, userId, today, actor: row.initiated_by };
  const check = def.validate(params, ctx);
  if (!check.ok) {
    const result = { error: check.error };
    db.prepare("UPDATE pending_actions SET status = 'failed', result = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), row.id);
    audit(db, {
      userId,
      actor: 'user',
      action: `${row.type}.confirmed`,
      entity: 'action',
      entityId: row.id,
      outcome: 'failed',
      detail: { reason: check.error },
    });
    noteToAssistant(db, userId, row, {
      kind: 'outcome',
      status: 'failed',
      title: 'Action not completed',
      summary: `I re-checked before executing and stopped: ${check.error}`,
    });
    throw new HttpError(422, check.error);
  }
  const result = tx(db, () => {
    const out = def.execute(check.value, { ...ctx, ...check });
    db.prepare("UPDATE pending_actions SET status = 'confirmed', result = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify(out), nowIso(), row.id);
    audit(db, {
      userId,
      actor: 'user',
      action: `${row.type}.confirmed`,
      entity: 'action',
      entityId: row.id,
      outcome: 'confirmed',
      detail: { initiatedBy: row.initiated_by },
    });
    audit(db, {
      userId,
      actor: row.initiated_by,
      action: `${row.type}.executed`,
      entity: out.entity,
      entityId: out.entityId,
      outcome: 'success',
      detail: { summary: out.summary, simulated: true },
    });
    return out;
  });
  noteToAssistant(db, userId, row, {
    kind: 'outcome',
    status: 'confirmed',
    title: 'Done in the sandbox',
    summary: result.summary,
    steps: [
      { label: 'Confirmed', detail: 'You approved the proposal.' },
      { label: 'Re-validated', detail: 'Amounts, currencies and wallet balance checked again on the server.' },
      { label: 'Executed', detail: result.summary },
      { label: 'Recorded', detail: `Audit event saved (${result.entityId}).` },
    ],
  });
  return { ...actionView({ ...row, status: 'confirmed', result: JSON.stringify(result) }), result };
}

export function rejectAction(db, userId, id) {
  const row = ownedPending(db, userId, id);
  db.prepare("UPDATE pending_actions SET status = 'rejected', resolved_at = ? WHERE id = ?").run(nowIso(), row.id);
  audit(db, { userId, actor: 'user', action: `${row.type}.rejected`, entity: 'action', entityId: row.id, outcome: 'rejected' });
  noteToAssistant(db, userId, row, {
    kind: 'outcome',
    status: 'rejected',
    title: 'Cancelled',
    summary: 'You declined the proposal. Nothing was changed or recorded.',
  });
  return actionView({ ...row, status: 'rejected' });
}

export function listPendingActions(db, userId) {
  return db
    .prepare("SELECT * FROM pending_actions WHERE user_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC")
    .all(userId, nowIso())
    .map((r) => actionView(r));
}
