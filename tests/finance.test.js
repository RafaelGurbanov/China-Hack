import { describe, expect, it } from 'vitest';
import {
  addMonths,
  compareTransfer,
  convert,
  endOfMonthForecast,
  formatMoney,
  fullMonthsBetween,
  monthlySpending,
  parseAmount,
  pickBest,
  quoteAll,
  quoteRoute,
  redactSensitive,
  round2,
  savingsPlan,
  TRANSFER_ROUTES,
  totalIn,
  validateDate,
  validateEmail,
  validatePassword,
  walletBalances,
} from '../shared/finance.js';

const route = (id) => TRANSFER_ROUTES.find((r) => r.id === id);

describe('money and conversion', () => {
  it('rounds half away from zero without binary drift', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-2.675)).toBe(-2.68);
  });
  it('formats with grouping, a real minus sign and the currency', () => {
    expect(formatMoney(1234.5, 'EUR')).toBe('1,234.50 EUR');
    expect(formatMoney(-45.06, 'EUR')).toBe('−45.06 EUR');
  });
  it('converts at the illustrative mid rate', () => {
    expect(convert(1000, 'AZN', 'EUR')).toBe(544.63);
    expect(convert(100, 'EUR', 'EUR')).toBe(100);
  });
});

describe('transfer quotes', () => {
  it('received = (amount − fee) × mid × (1 − margin)', () => {
    const q = quoteRoute(route('demo-online-transfer'), { amount: 500, from: 'AZN', to: 'EUR' });
    const mid = 0.5882 / 1.08;
    const fee = round2(Math.max(1.5 / 0.5882 + 500 * 0.006, 2 / 0.5882));
    expect(q.fee).toBe(fee);
    expect(q.receiveAmount).toBe(round2(round2(500 - fee) * mid * (1 - 0.004)));
    expect(q.totalCost).toBeCloseTo(round2(500 * mid) - q.receiveAmount, 2);
  });
  it('applies the minimum fee and route limits', () => {
    const small = quoteRoute(route('demo-bank-wire'), { amount: 50, from: 'AZN', to: 'EUR' });
    expect(small.eligible).toBe(false);
    const card = quoteRoute(route('demo-instant-card'), { amount: 20_000, from: 'AZN', to: 'EUR' });
    expect(card.eligible).toBe(false);
    expect(card.ineligibleReason).toMatch(/maximum/);
  });
  it('rejects same-currency transfers', () => {
    expect(quoteAll({ amount: 100, from: 'EUR', to: 'EUR' }).every((q) => !q.eligible)).toBe(true);
  });
  it('picks the best route per priority', () => {
    const quotes = quoteAll({ amount: 2000, from: 'AZN', to: 'EUR' });
    expect(pickBest(quotes, 'max_received').routeId).toBe('demo-online-transfer');
    expect(pickBest(quotes, 'fastest').routeId).toBe('demo-instant-card');
    expect(pickBest(quotes, 'lowest_fee').routeId).toBe('demo-online-transfer');
  });
  it('orders comparisons best first and reports the gap', () => {
    const c = compareTransfer({ amount: 500, from: 'AZN', to: 'EUR' });
    expect(c.quotes[0].isBest).toBe(true);
    expect(c.quotes.slice(1).every((q) => q.lessThanBest >= 0)).toBe(true);
    expect(c.rateSource).toMatch(/not live/);
  });
});

describe('validation', () => {
  it('parses amounts strictly', () => {
    expect(parseAmount('1200,50').value).toBe(1200.5);
    expect(parseAmount(42).value).toBe(42);
    expect(parseAmount('-5').error).toMatch(/negative/);
    expect(parseAmount('1e5').ok).toBe(false);
    expect(parseAmount('1,000').ok).toBe(false);
    expect(parseAmount('1.234').error).toMatch(/2 decimal/);
    expect(parseAmount('0').ok).toBe(false);
    expect(parseAmount('0', { allowZero: true }).ok).toBe(true);
    expect(parseAmount(Infinity).ok).toBe(false);
  });
  it('validates dates, emails and passwords', () => {
    expect(validateDate('2027-02-30').ok).toBe(false);
    expect(validateDate('2026-10-18', { today: '2026-10-18', future: true }).ok).toBe(false);
    expect(validateDate('2040-01-01', { today: '2026-10-18' }).ok).toBe(false);
    expect(validateEmail(' Student@Example.COM ').value).toBe('student@example.com');
    expect(validateEmail('nope').ok).toBe(false);
    expect(validatePassword('short1').ok).toBe(false);
    expect(validatePassword('onlyletterslong').ok).toBe(false);
    expect(validatePassword('CampusTest-2026').ok).toBe(true);
  });
  it('redacts card numbers, IBANs and credentials', () => {
    const r = redactSensitive('card 4111 1111 1111 1111, iban DE89 3704 0044 0532 0130 00, password: hunter22');
    expect(r.text).not.toMatch(/4111|DE89|hunter22/);
    expect(r.found).toEqual(expect.arrayContaining(['card_number', 'iban', 'credential']));
  });
  it('clamps month arithmetic to the end of the month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(fullMonthsBetween('2026-10-18', '2027-03-15')).toBe(4);
  });
});

describe('ledger, budget, savings and forecast', () => {
  const tx = [
    { type: 'opening_balance', amount: 1000, currency: 'AZN', occurredOn: '2026-09-01' },
    { type: 'income', amount: 450, currency: 'EUR', occurredOn: '2026-10-01', category: 'Part-time job' },
    { type: 'expense', amount: 300, currency: 'EUR', occurredOn: '2026-10-02', category: 'Housing' },
    { type: 'expense', amount: 100, currency: 'AZN', occurredOn: '2026-10-03', category: 'Food & groceries' },
    { type: 'transfer_out', amount: 500, currency: 'AZN', occurredOn: '2026-10-05' },
    { type: 'transfer_in', amount: 268.21, currency: 'EUR', occurredOn: '2026-10-05' },
    { type: 'savings_contribution', amount: 100, currency: 'EUR', occurredOn: '2026-10-06' },
    { type: 'expense', amount: 50, currency: 'EUR', occurredOn: '2026-11-02', category: 'Leisure' },
  ];
  it('computes wallet balances per currency up to a date', () => {
    expect(walletBalances(tx, '2026-10-18')).toEqual({ AZN: 400, EUR: 318.21 });
    expect(totalIn({ AZN: 400, EUR: 318.21 }, 'EUR')).toBe(round2(convert(400, 'AZN', 'EUR') + 318.21));
  });
  it('summarises monthly spending against limits, converting currencies', () => {
    const s = monthlySpending(
      tx,
      [
        { category: 'Housing', monthlyLimit: 250 },
        { category: 'Food & groceries', monthlyLimit: 100 },
      ],
      '2026-10',
      'EUR',
    );
    const housing = s.rows.find((r) => r.category === 'Housing');
    expect(housing.over).toBe(true);
    expect(housing.remaining).toBe(-50);
    expect(s.rows.find((r) => r.category === 'Food & groceries').spent).toBe(convert(100, 'AZN', 'EUR'));
    expect(s.rows.find((r) => r.category === 'Leisure').spent).toBe(0);
  });
  it('plans tuition savings and projects completion', () => {
    const goal = { name: 'Tuition', target: 4500, currency: 'EUR', deadline: '2027-03-15', startingSaved: 2000, plannedMonthly: 250 };
    const p = savingsPlan(goal, [{ amount: 600, currency: 'EUR' }], '2026-10-18');
    expect(p.saved).toBe(2600);
    expect(p.remaining).toBe(1900);
    expect(p.requiredMonthly).toBe(475);
    expect(p.monthsToFinish).toBe(8);
    expect(p.projectedCompletion).toBe('2027-06-18');
    expect(p.status).toBe('behind');
    expect(savingsPlan({ ...goal, plannedMonthly: 500 }, [{ amount: 600, currency: 'EUR' }], '2026-10-18').status).toBe('on_track');
    expect(savingsPlan({ ...goal, startingSaved: 4500 }, [], '2026-10-18').status).toBe('funded');
  });
  it('forecasts the end-of-month balance from budget and bills', () => {
    const spending = { spent: 400, limit: 600, remaining: 200 };
    const f = endOfMonthForecast({
      balances: { EUR: 1000 },
      currency: 'EUR',
      today: '2026-10-18',
      profile: { monthlySupport: 1200, supportDay: 25, homeCurrency: 'AZN' },
      spending,
      obligations: [{ amount: 320, currency: 'EUR', dueOn: '2026-10-27' }],
    });
    expect(f.supportExpected).toBe(convert(1200, 'AZN', 'EUR'));
    expect(f.expectedSpending).toBe(320);
    expect(f.estimate).toBe(round2(1000 + f.supportExpected - 320));
  });
});
