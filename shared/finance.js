/**
 * CampusBridge AI: shared financial logic.
 *
 * Every formula lives here once and is used by both the server (which is the
 * authority for stored data and consequential actions) and the browser (for
 * display). Pure functions only: no I/O, no clock reads unless a date is passed.
 *
 * IMPORTANT: exchange rates, transfer routes, fees and delivery times in this
 * file are ILLUSTRATIVE sample values. They are not live market data and do
 * not describe any real provider.
 */

// ---------------------------------------------------------------------------
// Money and formatting
// ---------------------------------------------------------------------------

/** Round half away from zero to 2 decimals, avoiding binary drift (1.005 -> 1.01). */
export function round2(value) {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}

export function round4(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000 + (value >= 0 ? 1e-9 : -1e-9)) / 10000;
}

function groupThousands(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1,234.50 EUR". Manual formatting so output is identical on server and browser. */
export function formatMoney(value, currency, opts = {}) {
  const decimals = opts.decimals ?? 2;
  const safe = Number.isFinite(value) ? value : 0;
  const negative = safe < 0;
  const fixed = Math.abs(decimals === 2 ? round2(safe) : safe).toFixed(decimals);
  const [i, d] = fixed.split('.');
  const body = groupThousands(i ?? '0') + (d ? `.${d}` : '');
  return `${negative ? '−' : ''}${body}${currency ? ` ${currency}` : ''}`;
}

export function formatRate(rate, from, to) {
  return `1 ${from} = ${round4(rate).toFixed(4)} ${to}`;
}

export function formatPercent(fraction, decimals = 0) {
  const safe = Number.isFinite(fraction) ? fraction : 0;
  return `${(safe * 100).toFixed(decimals)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Mar 2027" from "2027-03-15". */
export function formatDate(iso) {
  const d = parseISODate(iso);
  if (!d) return iso ?? '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Mar 2027" from "2027-03". */
export function formatMonth(key) {
  const [y, m] = String(key).split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Currencies and illustrative rates
// ---------------------------------------------------------------------------

export const RATE_SOURCE_LABEL = 'Illustrative exchange rate (fixed sample, not live)';

/** Value of one unit of each currency in USD. ILLUSTRATIVE, hand-entered values. */
export const USD_PER_UNIT = { USD: 1, EUR: 1.08, AZN: 0.5882, GBP: 1.27, TRY: 0.029, CNY: 0.138 };

export const CURRENCIES = [
  { code: 'AZN', name: 'Azerbaijani manat' },
  { code: 'EUR', name: 'Euro' },
  { code: 'USD', name: 'US dollar' },
  { code: 'GBP', name: 'British pound' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'CNY', name: 'Chinese yuan' },
];

/**
 * Places on the Money Atlas. Coordinates are approximate city positions used
 * only to draw an abstract map; each place is tied to one supported currency.
 */
export const ATLAS_PLACES = [
  { id: 'baku', country: 'Azerbaijan', city: 'Baku', currency: 'AZN', lon: 49.87, lat: 40.41 },
  { id: 'berlin', country: 'Germany', city: 'Berlin', currency: 'EUR', lon: 13.4, lat: 52.52 },
  { id: 'london', country: 'United Kingdom', city: 'London', currency: 'GBP', lon: -0.13, lat: 51.51 },
  { id: 'istanbul', country: 'Türkiye', city: 'Istanbul', currency: 'TRY', lon: 28.98, lat: 41.01 },
  { id: 'beijing', country: 'China', city: 'Beijing', currency: 'CNY', lon: 116.4, lat: 39.9 },
  { id: 'newyork', country: 'United States', city: 'New York', currency: 'USD', lon: -74.0, lat: 40.71 },
];

export function isCurrencyCode(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(USD_PER_UNIT, value);
}

/** Illustrative mid rate between two supported currencies. */
export function midRate(from, to) {
  if (from === to) return 1;
  return USD_PER_UNIT[from] / USD_PER_UNIT[to];
}

/** Convert an amount at the illustrative mid rate, rounded to cents. */
export function convert(amount, from, to) {
  return round2(amount * midRate(from, to));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const LIMITS = {
  amount: 1_000_000,
  monthly: 100_000,
  text: 60,
  note: 140,
  deadlineYears: 6,
  password: { min: 10, max: 128 },
};

// Control characters, zero-width characters and bidirectional overrides are
// invisible and are used to hide instructions or disguise text. Written as
// escapes so this source file contains no invisible characters itself.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE_ALL = new RegExp('[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]', 'g');
// eslint-disable-next-line no-control-regex -- same, but keeps tab and line breaks
const INVISIBLE_KEEP_LINES = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]', 'g');

export function stripInvisible(text, singleLine = false) {
  return String(text ?? '').replace(singleLine ? INVISIBLE_ALL : INVISIBLE_KEEP_LINES, '');
}

/**
 * Parse an amount typed by a person ("1200", "1200.5", "1200,50") or sent as a
 * JSON number. Rejects negatives, exponents, separators, NaN/Infinity and
 * values outside [min, max]. Returns { ok, value } or { ok: false, error }.
 */
export function parseAmount(raw, { field = 'Amount', min = 0, max = LIMITS.amount, required = true, allowZero = false } = {}) {
  let text;
  if (typeof raw === 'number') text = Number.isFinite(raw) ? String(raw) : 'x';
  else
    text = String(raw ?? '')
      .trim()
      .replace(/\s+/g, '');
  if (text === '') return required ? { ok: false, error: `${field} is required.` } : { ok: true, value: null };
  if (text.startsWith('-')) return { ok: false, error: `${field} cannot be negative.` };
  if (!/^\d+([.,]\d+)?$/.test(text)) return { ok: false, error: `${field} must be a plain number like 1200 or 1200.50.` };
  const normalized = text.replace(',', '.');
  const decimals = normalized.includes('.') ? normalized.split('.')[1].length : 0;
  if (decimals > 2) return { ok: false, error: `${field} can have at most 2 decimal places.` };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, error: `${field} is not a valid number.` };
  if (value === 0 && !allowZero) return { ok: false, error: `${field} must be greater than 0.` };
  if (value < min) return { ok: false, error: `${field} must be at least ${min}.` };
  if (value > max) return { ok: false, error: `${field} is too large. The maximum is ${groupThousands(String(max))}.` };
  return { ok: true, value };
}

export function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** Calendar date as YYYY-MM-DD (UTC parts). */
export function toISODate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Today's calendar date in the local time zone of whoever calls it, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Parse YYYY-MM-DD into a UTC-midnight Date, or null when not a real date. */
export function parseISODate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function addDays(iso, days) {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** Same day next month, clamped to the month's last day (31 Jan -> 28/29 Feb). */
export function addMonths(iso, months) {
  const d = parseISODate(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return toISODate(target);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((parseISODate(toIso) - parseISODate(fromIso)) / 86_400_000);
}

/** Whole months whose day-of-month has been reached. 18 Oct -> 15 Mar = 4. */
export function fullMonthsBetween(fromIso, toIso) {
  const a = parseISODate(fromIso);
  const b = parseISODate(toIso);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export function monthKey(iso) {
  return String(iso).slice(0, 7);
}

export function lastDayOfMonth(iso) {
  const d = parseISODate(iso);
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** A date within the allowed window: not before `earliest`, not more than `deadlineYears` after `today`. */
export function validateDate(raw, { field = 'Date', today, notBefore, future = false, maxYears = LIMITS.deadlineYears } = {}) {
  const d = parseISODate(raw);
  if (!d) return { ok: false, error: `${field} must be a real date (YYYY-MM-DD).` };
  const iso = toISODate(d);
  if (today && future && iso <= today) return { ok: false, error: `${field} must be in the future.` };
  if (notBefore && iso < notBefore) return { ok: false, error: `${field} is too far in the past.` };
  if (today && daysBetween(today, iso) > maxYears * 366) return { ok: false, error: `${field} must be within ${maxYears} years.` };
  return { ok: true, value: iso };
}

/** Clean a short label: strips invisible characters, caps length, refuses banking or personal details. */
export function cleanText(raw, { field = 'Text', max = LIMITS.text, required = true } = {}) {
  const text = stripInvisible(raw, true).replace(/\s+/g, ' ').trim();
  if (!text) return required ? { ok: false, error: `${field} is required.` } : { ok: true, value: '' };
  if (text.length > max) return { ok: false, error: `${field} must be ${max} characters or fewer.` };
  if (redactSensitive(text).found.length) {
    return { ok: false, error: `${field} looks like it contains card, account or personal details. Use a plain description like "Groceries".` };
  }
  return { ok: true, value: text };
}

export function validateEmail(raw) {
  const email = stripInvisible(raw, true).trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email is required.' };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  return { ok: true, value: email };
}

export function validatePassword(raw) {
  const pw = typeof raw === 'string' ? raw : '';
  const { min, max } = LIMITS.password;
  if (pw.length < min) return { ok: false, error: `Password must be at least ${min} characters.` };
  if (pw.length > max) return { ok: false, error: `Password must be ${max} characters or fewer.` };
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return { ok: false, error: 'Password must contain at least one letter and one number.' };
  return { ok: true, value: pw };
}

// ---------------------------------------------------------------------------
// Sensitive-data detection
// ---------------------------------------------------------------------------

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CREDENTIAL_RE = /\b(password|passcode|pin|cvv|cvc|otp|one[- ]time code|login|username|api[_ -]?key|secret|token)\s*(is|:|=)\s*\S+/gi;

/** Redact card numbers (Luhn), IBANs, credentials, emails, phone and ID-like numbers. */
export function redactSensitive(input) {
  const found = new Set();
  let text = String(input ?? '');
  text = text.replace(CREDENTIAL_RE, (_m, word) => {
    found.add('credential');
    return `${word}: [removed]`;
  });
  text = text.replace(EMAIL_RE, () => {
    found.add('email');
    return '[email removed]';
  });
  text = text.replace(IBAN_RE, (m) => {
    const compact = m.replace(/\s/g, '');
    if (compact.length >= 15 && compact.length <= 34 && /\d{6,}/.test(compact.slice(4))) {
      found.add('iban');
      return '[account number removed]';
    }
    return m;
  });
  text = text.replace(/\+\d{1,3}[\s-]?(?:\(?\d{1,4}\)?[\s-]?){2,5}\d{2,4}/g, (m) => {
    if (m.replace(/\D/g, '').length >= 9) {
      found.add('phone');
      return '[phone removed]';
    }
    return m;
  });
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      found.add('card_number');
      return '[card number removed]';
    }
    if (digits.length >= 9) {
      found.add('id_number');
      return '[number removed]';
    }
    return m;
  });
  return { text, found: [...found] };
}

export function describeSensitive(kinds) {
  const names = {
    card_number: 'a card number',
    iban: 'a bank account number',
    credential: 'a password or access code',
    email: 'an email address',
    phone: 'a phone number',
    id_number: 'a long ID-style number',
  };
  return kinds.map((k) => names[k]).join(', ');
}

// ---------------------------------------------------------------------------
// Illustrative transfer routes (simulated)
// ---------------------------------------------------------------------------

/**
 * Fictional route archetypes, not real providers ("Demo" prefix on purpose).
 * Margins, fees, limits and delivery times are invented sample values.
 * Fees and limits are in USD-equivalent and converted per currency.
 */
export const TRANSFER_ROUTES = [
  {
    id: 'demo-bank-wire',
    name: 'Demo Bank Wire',
    kind: 'Bank wire',
    fxMargin: 0.018,
    fixedFeeUSD: 20,
    percentFee: 0.002,
    minFeeUSD: 20,
    deliveryHoursMin: 48,
    deliveryHoursMax: 120,
    minSendUSD: 50,
    maxSendUSD: 500_000,
    goodFor: 'Large tuition payments when the university asks for a wire.',
  },
  {
    id: 'demo-online-transfer',
    name: 'Demo Online Transfer',
    kind: 'Online transfer service',
    fxMargin: 0.004,
    fixedFeeUSD: 1.5,
    percentFee: 0.006,
    minFeeUSD: 2,
    deliveryHoursMin: 4,
    deliveryHoursMax: 48,
    minSendUSD: 10,
    maxSendUSD: 60_000,
    goodFor: 'Everyday living costs and mid-sized amounts.',
  },
  {
    id: 'demo-instant-card',
    name: 'Demo Instant Card',
    kind: 'Card-funded instant transfer',
    fxMargin: 0.022,
    fixedFeeUSD: 3,
    percentFee: 0.012,
    minFeeUSD: 4,
    deliveryHoursMin: 0.1,
    deliveryHoursMax: 1,
    minSendUSD: 5,
    maxSendUSD: 5_000,
    goodFor: 'Small urgent amounts. Usually the costliest per unit.',
  },
  {
    id: 'demo-tuition-portal',
    name: 'Demo Tuition Portal',
    kind: 'Education payment portal',
    fxMargin: 0.009,
    fixedFeeUSD: 10,
    percentFee: 0,
    minFeeUSD: 10,
    deliveryHoursMin: 24,
    deliveryHoursMax: 72,
    minSendUSD: 200,
    maxSendUSD: 250_000,
    goodFor: 'Tuition paid straight to a university that supports such portals.',
  },
];

export const PRIORITIES = {
  max_received: 'Most received',
  fastest: 'Fastest',
  lowest_fee: 'Lowest fee',
  balanced: 'Balanced',
};

function usdTo(amountUSD, currency) {
  return amountUSD * midRate('USD', currency);
}

export function deliveryLabel(minH, maxH) {
  const fmt = (h) => {
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 24) return `${Math.round(h)} h`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
  };
  return `${fmt(minH)} – ${fmt(maxH)}`;
}

/**
 * Quote one route for sending `amount` of `from`, received in `to`.
 *   fee      = max(fixed fee + percent fee × amount, minimum fee)   (in `from`)
 *   rate     = illustrative mid rate × (1 − route margin)
 *   received = (amount − fee) × rate
 */
export function quoteRoute(route, { amount, from, to }) {
  const mid = midRate(from, to);
  const rate = mid * (1 - route.fxMargin);
  const sendAmount = round2(amount);
  const fee = round2(Math.max(usdTo(route.fixedFeeUSD, from) + sendAmount * route.percentFee, usdTo(route.minFeeUSD, from)));
  const convertedAmount = round2(Math.max(0, sendAmount - fee));
  const receiveAmount = round2(convertedAmount * rate);
  const receiveAtMid = round2(sendAmount * mid);
  const totalCost = round2(Math.max(0, receiveAtMid - receiveAmount));
  const sendUSD = sendAmount * midRate(from, 'USD');
  let eligible = true;
  let ineligibleReason = null;
  if (from === to) {
    eligible = false;
    ineligibleReason = 'Source and destination currency are the same.';
  } else if (sendUSD < route.minSendUSD) {
    eligible = false;
    ineligibleReason = `Below this route's minimum of about ${formatMoney(usdTo(route.minSendUSD, from), from, { decimals: 0 })}.`;
  } else if (sendUSD > route.maxSendUSD) {
    eligible = false;
    ineligibleReason = `Above this route's maximum of about ${formatMoney(usdTo(route.maxSendUSD, from), from, { decimals: 0 })}.`;
  } else if (receiveAmount <= 0) {
    eligible = false;
    ineligibleReason = 'The fee would use up the whole amount.';
  }
  return {
    routeId: route.id,
    routeName: route.name,
    kind: route.kind,
    goodFor: route.goodFor,
    eligible,
    ineligibleReason,
    sendAmount,
    sendCurrency: from,
    fee,
    convertedAmount,
    rate: round4(rate),
    midRate: round4(mid),
    marginPct: route.fxMargin,
    receiveAmount,
    receiveCurrency: to,
    receiveAtMid,
    totalCost,
    totalCostPct: receiveAtMid > 0 ? totalCost / receiveAtMid : 0,
    deliveryHoursMax: route.deliveryHoursMax,
    deliveryLabel: deliveryLabel(route.deliveryHoursMin, route.deliveryHoursMax),
  };
}

export function quoteAll(req) {
  return TRANSFER_ROUTES.map((r) => quoteRoute(r, req));
}

/** Best eligible quote for a priority; the balanced score is 60% cost and 40% speed. */
export function pickBest(quotes, priority = 'max_received') {
  const eligible = quotes.filter((q) => q.eligible);
  if (!eligible.length) return null;
  const byValue = (a, b) => b.receiveAmount - a.receiveAmount;
  const sorted = [...eligible];
  if (priority === 'fastest') sorted.sort((a, b) => a.deliveryHoursMax - b.deliveryHoursMax || byValue(a, b));
  else if (priority === 'lowest_fee') sorted.sort((a, b) => a.fee / a.sendAmount - b.fee / b.sendAmount || byValue(a, b));
  else if (priority === 'balanced') {
    const costs = eligible.map((q) => q.totalCostPct);
    const speeds = eligible.map((q) => Math.log1p(q.deliveryHoursMax));
    const norm = (v, lo, hi) => (hi === lo ? 1 : 1 - (v - lo) / (hi - lo));
    const score = (q) =>
      0.6 * norm(q.totalCostPct, Math.min(...costs), Math.max(...costs)) + 0.4 * norm(Math.log1p(q.deliveryHoursMax), Math.min(...speeds), Math.max(...speeds));
    sorted.sort((a, b) => score(b) - score(a) || byValue(a, b));
  } else sorted.sort((a, b) => byValue(a, b) || a.deliveryHoursMax - b.deliveryHoursMax);
  return sorted[0];
}

/** Quotes ordered best-first, with the best one marked. */
export function compareTransfer({ amount, from, to, priority = 'max_received' }) {
  const quotes = quoteAll({ amount, from, to });
  const best = pickBest(quotes, priority);
  const rest = quotes.filter((q) => q !== best).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.receiveAmount - a.receiveAmount);
  const ordered = best ? [best, ...rest] : rest;
  return {
    amount: round2(amount),
    from,
    to,
    priority,
    midRate: round4(midRate(from, to)),
    rateSource: RATE_SOURCE_LABEL,
    bestRouteId: best?.routeId ?? null,
    quotes: ordered.map((q) => ({ ...q, isBest: q === best, lessThanBest: best && q.eligible ? round2(best.receiveAmount - q.receiveAmount) : null })),
  };
}

// ---------------------------------------------------------------------------
// Ledger, budgets, savings and forecasts
// ---------------------------------------------------------------------------

export const EXPENSE_CATEGORIES = ['Housing', 'Food & groceries', 'Transport', 'Education', 'Health & insurance', 'Phone & internet', 'Leisure', 'Other'];
export const INCOME_CATEGORIES = ['Family support', 'Part-time job', 'Scholarship', 'Opening balance', 'Other income'];

/** Sign of each ledger entry type: + adds to a wallet, − takes from it. */
export const LEDGER_SIGN = {
  opening_balance: 1,
  income: 1,
  transfer_in: 1,
  expense: -1,
  transfer_out: -1,
  savings_contribution: -1,
};

/** Wallet balance per currency, from ledger entries up to and including `asOf`. */
export function walletBalances(transactions, asOf) {
  const out = {};
  for (const t of transactions) {
    if (asOf && t.occurredOn > asOf) continue;
    const sign = LEDGER_SIGN[t.type] ?? 0;
    out[t.currency] = round2((out[t.currency] ?? 0) + sign * t.amount);
  }
  return out;
}

/** Total of all wallets in one currency at the illustrative rate. */
export function totalIn(balances, currency) {
  return round2(Object.entries(balances).reduce((acc, [c, v]) => acc + convert(v, c, currency), 0));
}

/** Spending for one month, per category, in the study currency, against budget limits. */
export function monthlySpending(transactions, budgets, month, currency) {
  const byCategory = {};
  for (const c of EXPENSE_CATEGORIES) byCategory[c] = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' || monthKey(t.occurredOn) !== month) continue;
    const cat = byCategory[t.category] === undefined ? 'Other' : t.category;
    byCategory[cat] = round2(byCategory[cat] + convert(t.amount, t.currency, currency));
  }
  const limits = Object.fromEntries((budgets ?? []).map((b) => [b.category, b.monthlyLimit]));
  const rows = EXPENSE_CATEGORIES.map((category) => {
    const spent = byCategory[category];
    const limit = limits[category] ?? 0;
    return {
      category,
      spent,
      limit,
      remaining: round2(limit - spent),
      utilization: limit > 0 ? spent / limit : spent > 0 ? 1 : 0,
      over: limit > 0 ? spent > limit : spent > 0,
    };
  });
  const spent = round2(rows.reduce((a, r) => a + r.spent, 0));
  const limit = round2(rows.reduce((a, r) => a + r.limit, 0));
  return { month, currency, rows, spent, limit, remaining: round2(limit - spent), utilization: limit > 0 ? spent / limit : 0 };
}

/** Spending totals for the last `count` months ending with `month`. */
export function spendingTrend(transactions, month, currency, count = 6) {
  const keys = [];
  const [y, m] = month.split('-').map(Number);
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  }
  return keys.map((key) => ({
    month: key,
    spent: round2(
      transactions.filter((t) => t.type === 'expense' && monthKey(t.occurredOn) === key).reduce((a, t) => a + convert(t.amount, t.currency, currency), 0),
    ),
  }));
}

/**
 * Tuition savings plan.
 *   saved            = starting savings + contributions so far
 *   remaining        = max(0, target − saved)
 *   required/month   = remaining ÷ full months to the deadline (at least 1)
 *   completion date  = today + ceil(remaining ÷ planned monthly saving) months
 */
export function savingsPlan(goal, contributions, today) {
  if (!goal) return null;
  const contributed = round2(contributions.reduce((a, c) => a + convert(c.amount, c.currency, goal.currency), 0));
  const saved = round2(goal.startingSaved + contributed);
  const target = round2(goal.target);
  const remaining = round2(Math.max(0, target - saved));
  const progress = target > 0 ? Math.min(1, saved / target) : 1;
  const daysLeft = daysBetween(today, goal.deadline);
  const monthsLeft = daysLeft > 0 ? fullMonthsBetween(today, goal.deadline) : 0;
  const requiredMonthly = remaining === 0 ? 0 : round2(remaining / Math.max(1, monthsLeft));
  const planned = round2(goal.plannedMonthly ?? 0);
  let monthsToFinish = null;
  let projectedCompletion = null;
  if (remaining === 0) {
    monthsToFinish = 0;
    projectedCompletion = today;
  } else if (planned > 0) {
    monthsToFinish = Math.ceil(remaining / planned - 1e-9);
    projectedCompletion = addMonths(today, monthsToFinish);
  }
  const projectedAtDeadline = round2(Math.min(target, saved + planned * monthsLeft));
  const shortfallAtDeadline = round2(Math.max(0, target - (saved + planned * monthsLeft)));
  let status;
  if (remaining === 0) status = 'funded';
  else if (daysLeft <= 0) status = 'deadline_passed';
  else if (planned <= 0) status = 'no_plan';
  else if (projectedCompletion <= goal.deadline) status = 'on_track';
  else status = 'behind';
  return {
    name: goal.name,
    currency: goal.currency,
    target,
    deadline: goal.deadline,
    startingSaved: round2(goal.startingSaved),
    contributed,
    saved,
    remaining,
    progress,
    daysLeft,
    monthsLeft,
    requiredMonthly,
    plannedMonthly: planned,
    monthlyGap: round2(Math.max(0, requiredMonthly - planned)),
    monthsToFinish,
    projectedCompletion,
    projectedAtDeadline,
    shortfallAtDeadline,
    status,
  };
}

export const SAVINGS_STATUS = {
  funded: 'Fully funded',
  on_track: 'On track',
  behind: 'Behind schedule',
  no_plan: 'No monthly saving planned',
  deadline_passed: 'Deadline passed',
};

/**
 * Estimated balance at the end of the current month, in the study currency.
 *   available now
 * + support still expected this month (if its day is still ahead)
 * − the larger of: unused monthly budget, or unpaid bills due this month
 *   (with no budget set: spending so far, extended at the same daily pace)
 */
export function endOfMonthForecast({ balances, currency, today, profile, spending, obligations }) {
  const available = totalIn(balances, currency);
  const day = Number(today.slice(8, 10));
  const monthEnd = lastDayOfMonth(today);
  const daysInMonth = Number(monthEnd.slice(8, 10));
  const supportExpected =
    profile.monthlySupport > 0 && profile.supportDay > day && profile.supportDay <= daysInMonth
      ? convert(profile.monthlySupport, profile.homeCurrency, currency)
      : 0;
  const billsDue = round2(obligations.filter((o) => o.dueOn >= today && o.dueOn <= monthEnd).reduce((a, o) => a + convert(o.amount, o.currency, currency), 0));
  let expectedSpending;
  let method;
  if (spending.limit > 0) {
    expectedSpending = round2(Math.max(Math.max(0, spending.remaining), billsDue));
    method = 'budget';
  } else {
    const pace = day > 0 ? spending.spent / day : 0;
    expectedSpending = round2(Math.max(pace * (daysInMonth - day), billsDue));
    method = 'pace';
  }
  return {
    currency,
    asOf: today,
    monthEnd,
    available,
    supportExpected,
    billsDue,
    expectedSpending,
    method,
    estimate: round2(available + supportExpected - expectedSpending),
  };
}

/** Upcoming obligations within `days`, plus the tuition deadline, soonest first. */
export function upcomingObligations(obligations, goalPlan, today, days = 60) {
  const until = addDays(today, days);
  const items = obligations
    .filter((o) => o.dueOn >= today && o.dueOn <= until)
    .map((o) => ({
      id: o.id,
      name: o.name,
      amount: o.amount,
      currency: o.currency,
      dueOn: o.dueOn,
      kind: o.recurring === 'monthly' ? 'Monthly bill' : 'One-off',
      daysAway: daysBetween(today, o.dueOn),
    }));
  if (goalPlan && goalPlan.remaining > 0 && goalPlan.deadline >= today) {
    items.push({
      id: 'tuition',
      name: `${goalPlan.name} (still to save)`,
      amount: goalPlan.remaining,
      currency: goalPlan.currency,
      dueOn: goalPlan.deadline,
      kind: 'Tuition deadline',
      daysAway: goalPlan.daysLeft,
    });
  }
  return items.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}
