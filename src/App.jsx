/**
 * CampusBridge AI — frontend.
 *
 * One file by design: UI kit, layout, auth screens, the Money Atlas and the
 * eight workspace views. Financial formulas come from ../shared/finance.js and
 * all records come from the Express API; the server is the source of truth.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BookOpen,
  Bus,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  HeartPulse,
  Home,
  Landmark,
  Loader2,
  LogOut,
  Menu,
  Pencil,
  PiggyBank,
  Plus,
  RefreshCw,
  Search,
  ShoppingBasket,
  Smartphone,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import {
  ATLAS_PLACES,
  CURRENCIES,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  LIMITS,
  PRIORITIES,
  RATE_SOURCE_LABEL,
  SAVINGS_STATUS,
  addMonths,
  compareTransfer,
  formatDate,
  formatMoney,
  formatMonth,
  formatPercent,
  formatRate,
  midRate,
  monthKey,
  round2,
} from '../shared/finance.js';

// ===========================================================================
// API client
// ===========================================================================

class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields ?? null;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-campusbridge-request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the CampusBridge server. Check that it is running, then try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `The server answered ${res.status}. Make sure the CampusBridge server is running.`, data?.fields);
  return data;
}

// ===========================================================================
// Helpers
// ===========================================================================

const cx = (...parts) => parts.filter(Boolean).join(' ');
const SYMBOL = { EUR: '€', USD: '$', GBP: '£', AZN: '₼', TRY: '₺', CNY: '¥' };
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateTime = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const clock = (iso) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const firstName = (name) => String(name ?? '').split(' ')[0];
const placeFor = (currency) => ATLAS_PLACES.find((p) => p.currency === currency);

/** Split a money value for display: symbol, whole part, cents. */
function moneyParts(value, currency) {
  const neg = value < 0;
  const [int, dec] = Math.abs(round2(value)).toFixed(2).split('.');
  return { sign: neg ? '−' : '', symbol: SYMBOL[currency] ?? '', code: currency, int: int.replace(/\B(?=(\d{3})+(?!\d))/g, ','), dec };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

let balanceRevealed = false;
/** Count up to `target` once per page load (the single orchestrated reveal). */
function useCountUp(target, ms = 1100) {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(() => (balanceRevealed || reduced ? target : 0));
  const [lastTarget, setLastTarget] = useState(target);
  if (balanceRevealed && target !== lastTarget) {
    setLastTarget(target);
    setValue(target);
  }
  useEffect(() => {
    if (balanceRevealed || reduced) return undefined;
    balanceRevealed = true;
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / ms);
      setValue(target * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduced]);
  return value;
}

// ===========================================================================
// Contexts
// ===========================================================================

const AuthContext = createContext(null);
const WorkspaceContext = createContext(null);
const ToastContext = createContext(null);
const useAuth = () => useContext(AuthContext);
const useWorkspace = () => useContext(WorkspaceContext);
const useToast = () => useContext(ToastContext);

function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, notice: null });
  const check = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const d = await api('/auth/me');
      setState({ status: 'ready', user: d.user, notice: null });
    } catch (e) {
      setState({ status: 'offline', user: null, notice: e.message });
    }
  }, []);
  useEffect(() => {
    let alive = true;
    api('/auth/me')
      .then((d) => alive && setState({ status: 'ready', user: d.user, notice: null }))
      .catch((e) => alive && setState({ status: 'offline', user: null, notice: e.message }));
    return () => {
      alive = false;
    };
  }, []);
  const value = useMemo(
    () => ({
      ...state,
      retry: check,
      async login(email, password) {
        const d = await api('/auth/login', { method: 'POST', body: { email, password } });
        setState({ status: 'ready', user: d.user, notice: null });
      },
      async register(body) {
        const d = await api('/auth/register', { method: 'POST', body });
        setState({ status: 'ready', user: d.user, notice: null });
      },
      async logout() {
        try {
          await api('/auth/logout', { method: 'POST' });
        } finally {
          balanceRevealed = false;
          setState({ status: 'ready', user: null, notice: 'You have signed out.' });
        }
      },
      expire() {
        setState({ status: 'ready', user: null, notice: 'Your session has ended. Sign in again to continue.' });
      },
    }),
    [state, check],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function WorkspaceProvider({ children }) {
  const { expire } = useAuth();
  const [ws, setWs] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    try {
      const d = await api('/workspace');
      setWs(d);
      setError(null);
      return d;
    } catch (e) {
      if (e.status === 401) expire();
      else setError(e.message);
      return null;
    }
  }, [expire]);
  useEffect(() => {
    let alive = true;
    api('/workspace')
      .then((d) => alive && setWs(d))
      .catch((e) => {
        if (!alive) return;
        if (e.status === 401) expire();
        else setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [expire]);
  const mutate = useCallback(
    async (fn) => {
      try {
        const out = await fn();
        await reload();
        return out;
      } catch (e) {
        if (e.status === 401) expire();
        throw e;
      }
    },
    [reload, expire],
  );
  return <WorkspaceContext.Provider value={{ ws, error, reload, mutate }}>{children}</WorkspaceContext.Provider>;
}

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:right-auto sm:w-[26rem]">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="rise pointer-events-auto flex items-start gap-3 rounded-[var(--radius-ctl)] bg-ink px-4 py-3 text-sm text-paper shadow-[0_12px_30px_-12px_rgb(23_25_22/0.5)]"
          >
            <span
              aria-hidden="true"
              className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full', t.tone === 'error' ? 'bg-coral text-ink' : t.tone === 'success' ? 'bg-lime text-ink' : 'bg-paper/20 text-paper')}
            >
              {t.tone === 'error' ? <CircleAlert className="size-3.5" /> : <Check className="size-3.5" />}
            </span>
            <p className="min-w-0 flex-1">{t.message}</p>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-paper/60 hover:text-paper">
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ===========================================================================
// UI kit
// ===========================================================================

const BTN = {
  ink: 'bg-ink text-paper hover:bg-forest disabled:bg-ink/40',
  lime: 'bg-lime text-ink hover:bg-lime-2 disabled:bg-lime/40',
  outline: 'border border-ink/25 text-ink hover:border-ink hover:bg-paper-3',
  outlineDark: 'border border-paper/30 text-paper hover:border-paper hover:bg-paper/5',
  ghost: 'text-forest underline-offset-4 hover:underline',
  danger: 'border border-coral-ink/40 text-coral-ink hover:bg-coral/10',
};

function Button({ variant = 'ink', size = 'md', icon: Icon, busy = false, className, children, type = 'button', disabled, ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-ctl)] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'min-h-9 px-3 text-[0.8125rem]' : size === 'lg' ? 'min-h-13 px-6 text-[0.9375rem]' : 'min-h-11 px-4 text-sm',
        variant === 'ghost' && 'min-h-0 px-0',
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
      {children}
    </button>
  );
}

/** Dashed tag: the visual marker for anything illustrative or simulated. */
function SimTag({ children = 'Simulated', dark = false, className }) {
  return (
    <span
      className={cx(
        'sim-dash inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        dark ? 'border-paper/40 text-paper/80' : 'border-ink/35 text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

function Notice({ tone = 'info', title, children, action, className }) {
  const styles = {
    info: 'border-ink/15 bg-paper-3',
    danger: 'border-coral-ink/40 bg-coral/10',
    success: 'border-forest/30 bg-forest/5',
    sim: 'sim-dash border-ink/30 bg-paper-3',
  };
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cx('rounded-[var(--radius-panel)] border p-4 text-sm', styles[tone], className)}>
      {title ? <p className={cx('font-semibold', tone === 'danger' ? 'text-coral-ink' : 'text-ink')}>{title}</p> : null}
      {children ? <div className={cx('text-ink-2', title && 'mt-0.5')}>{children}</div> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

function Empty({ title, children, action, dark }) {
  return (
    <div className={cx('sim-dash rounded-[var(--radius-panel)] border px-5 py-8 text-center', dark ? 'border-paper/25' : 'border-ink/20')}>
      <p className={cx('font-display text-xl', dark ? 'text-paper' : 'text-ink')}>{title}</p>
      {children ? <p className={cx('mx-auto mt-1 max-w-sm text-sm', dark ? 'text-mist' : 'text-ink-3')}>{children}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const Skeleton = ({ className }) => <div aria-hidden="true" className={cx('animate-pulse rounded-[var(--radius-ctl)] bg-stone/60', className)} />;

function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-8 py-10">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-36 w-2/3" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Skeleton className="h-56 lg:col-span-2" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}

function PageIntro({ title, lead, aside, className }) {
  return (
    <header className={cx('flex flex-wrap items-end justify-between gap-x-10 gap-y-4 pt-10 pb-8 sm:pt-14', className)}>
      <div className="min-w-0 max-w-3xl">
        <h1 data-page-title tabIndex={-1} className="text-[2.75rem] leading-[0.95] outline-none sm:text-[4rem]">
          {title}
        </h1>
        {lead ? <p className="mt-4 max-w-[60ch] text-[1.0625rem] text-ink-2">{lead}</p> : null}
      </div>
      {aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : null}
    </header>
  );
}

function SectionHead({ title, note, action, id, dark }) {
  return (
    <div className={cx('mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b pb-3', dark ? 'rule-dark' : 'rule')}>
      <h2 id={id} className={cx('text-[1.625rem] leading-tight', dark && 'text-paper')}>
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        {note ? <p className={cx('text-sm', dark ? 'text-mist' : 'text-ink-3')}>{note}</p> : null}
        {action}
      </div>
    </div>
  );
}

const INPUT =
  'min-h-11 w-full rounded-[var(--radius-ctl)] border bg-paper-3 px-3 text-[0.9375rem] text-ink outline-none placeholder:text-ink-3/70 focus:border-forest focus:ring-2 focus:ring-forest/20';

function Field({ label, error, hint, children, className, dark }) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className={cx('mb-1.5 block text-[0.8125rem] font-medium', dark ? 'text-mist' : 'text-ink-2')}>
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, className: cx(INPUT, error ? 'border-coral-ink' : 'border-ink/20') })}
      {error ? (
        <p id={`${id}-err`} className="mt-1.5 text-[0.8125rem] font-medium text-coral-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className={cx('mt-1.5 text-[0.8125rem]', dark ? 'text-mist' : 'text-ink-3')}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const TextField = ({ label, error, hint, className, dark, ...props }) => (
  <Field label={label} error={error} hint={hint} className={className} dark={dark}>
    {(a) => <input {...a} {...props} />}
  </Field>
);
const MoneyField = (props) => <TextField inputMode="decimal" autoComplete="off" {...props} />;
const SelectField = ({ label, error, hint, options, className, ...props }) => (
  <Field label={label} error={error} hint={hint} className={className}>
    {(a) => (
      <select {...a} {...props}>
        {options.map((o) => (typeof o === 'string' ? <option key={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    )}
  </Field>
);
const currencyOptions = CURRENCIES.map((c) => ({ value: c.code, label: `${c.code}, ${c.name}` }));

/** Text tabs: a radio group drawn as words with a lime marker on the chosen one. */
function Tabs({ label, value, options, onChange, dark }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-x-1 gap-y-1">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            'relative inline-flex min-h-9 cursor-pointer items-center rounded-[var(--radius-ctl)] px-3 text-sm font-medium transition-colors',
            o.value === value ? 'bg-lime text-ink' : dark ? 'text-mist hover:text-paper' : 'text-ink-3 hover:text-ink',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-forest',
          )}
        >
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function Rows({ rows, className, dark }) {
  return (
    <dl className={cx('divide-y', dark ? 'divide-paper/15' : 'divide-ink/10', className)}>
      {rows.map(([k, v, opts = {}]) => (
        <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm">
          <dt className={dark ? 'text-mist' : 'text-ink-3'}>{k}</dt>
          <dd className={cx('tabular text-right', opts.strong && 'font-semibold', dark ? 'text-paper' : 'text-ink', opts.tone === 'coral' && (dark ? 'text-coral' : 'text-coral-ink'), opts.mono && 'font-mono text-[0.8125rem]')}>
            {opts.mark ? <span className="mark">{v}</span> : v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Dialog({ open, onClose, title, description, children, footer, wide }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx(
        'm-auto max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[var(--radius-panel)] border border-ink/15 bg-paper p-0 text-ink',
        wide ? 'w-[min(44rem,calc(100vw-2rem))]' : 'w-[min(32rem,calc(100vw-2rem))]',
      )}
    >
      {open ? (
        <div className="p-6 sm:p-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-[1.75rem] leading-tight">
                {title}
              </h2>
              {description ? <p className="mt-1.5 text-sm text-ink-2">{description}</p> : null}
            </div>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded-[var(--radius-ctl)] p-1 text-ink-3 hover:bg-paper-2 hover:text-ink">
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
          {children}
          {footer ? <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onCancel }) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'ink'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[0.9375rem] text-ink-2">{children}</div>
    </Dialog>
  );
}

// ===========================================================================
// Sandbox actions: propose on the server, review, confirm or cancel
// ===========================================================================

function ActionReviewDialog({ action, busy, error, onConfirm, onCancel }) {
  const [ack, setAck] = useState(false);
  const [lastId, setLastId] = useState(null);
  if ((action?.id ?? null) !== lastId) {
    setLastId(action?.id ?? null);
    setAck(false);
  }
  const p = action?.preview;
  const isTransfer = action?.type === 'simulate_transfer';
  return (
    <Dialog
      open={Boolean(action)}
      onClose={onCancel}
      title={isTransfer ? 'Confirm simulated transfer' : 'Confirm this action'}
      description={p?.title}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} busy={busy} disabled={isTransfer && !ack} icon={Check}>
            {isTransfer ? 'Confirm simulation' : 'Confirm'}
          </Button>
        </>
      }
    >
      {p ? (
        <>
          {p.highlight ? (
            <p className="numeral text-[3.25rem] text-ink">
              <span className="mark">{p.highlight}</span>
            </p>
          ) : null}
          <Rows className="mt-4" rows={p.rows.map(([k, v]) => [k, v, k.startsWith('Estimated to arrive') ? { strong: true } : {}])} />
          <p className="sim-dash mt-4 rounded-[var(--radius-ctl)] border border-ink/30 p-3 text-sm text-ink-2">{p.note}</p>
          {action.initiatedBy === 'assistant' ? <p className="mt-3 text-xs text-ink-3">Proposed by Bridge Intelligence. Nothing happens until you confirm.</p> : null}
          {isTransfer ? (
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-forest" />
              <span>I understand this is a simulation and no money will be sent.</span>
            </label>
          ) : null}
          {error ? (
            <Notice tone="danger" className="mt-4" title="Not completed">
              {error}
            </Notice>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

function useSandboxAction(onSettled) {
  const { reload } = useWorkspace();
  const { expire } = useAuth();
  const { notify } = useToast();
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const propose = async (type, params) => {
    try {
      const d = await api('/actions', { method: 'POST', body: { type, params } });
      setError(null);
      setAction(d.action);
      return true;
    } catch (e) {
      if (e.status === 401) expire();
      notify(e.message, 'error');
      return false;
    }
  };
  const open = (a) => {
    setError(null);
    setAction(a);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const d = await api(`/actions/${action.id}/confirm`, { method: 'POST' });
      notify(d.action.result.summary, 'success');
      setAction(null);
      await reload();
      onSettled?.();
    } catch (e) {
      setError(e.message);
      await reload();
      onSettled?.();
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const a = action;
    setAction(null);
    setError(null);
    if (a && !error) {
      try {
        await api(`/actions/${a.id}/reject`, { method: 'POST' });
        notify('Cancelled. Nothing was recorded.', 'info');
        await reload();
        onSettled?.();
      } catch {
        /* already resolved or expired */
      }
    }
  };
  return { propose, open, dialog: <ActionReviewDialog action={action} busy={busy} error={error} onConfirm={confirm} onCancel={cancel} /> };
}

// ===========================================================================
// Money Atlas
// ===========================================================================

const ATLAS = { lonMin: -84, lonMax: 126, latMin: 22, latMax: 66, w: 1000, yStretch: 1.55 };
ATLAS.h = Math.round((ATLAS.w * (ATLAS.latMax - ATLAS.latMin) * ATLAS.yStretch) / ((ATLAS.lonMax - ATLAS.lonMin) * Math.cos((44 * Math.PI) / 180)));
const project = (lon, lat) => [((lon - ATLAS.lonMin) / (ATLAS.lonMax - ATLAS.lonMin)) * ATLAS.w, ((ATLAS.latMax - lat) / (ATLAS.latMax - ATLAS.latMin)) * ATLAS.h];
const LABEL_POS = {
  baku: { dx: 12, dy: 22, anchor: 'start' },
  berlin: { dx: 10, dy: -14, anchor: 'start' },
  london: { dx: -12, dy: -14, anchor: 'end' },
  istanbul: { dx: -10, dy: 24, anchor: 'end' },
  beijing: { dx: -12, dy: -14, anchor: 'end' },
  newyork: { dx: 12, dy: -14, anchor: 'start' },
};

/** A curved route that bows north, like a great-circle arc on a flat projection. */
function routePath(a, b) {
  const [x1, y1] = project(a.lon, a.lat);
  const [x2, y2] = project(b.lon, b.lat);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  let nx = -(y2 - y1) / dist;
  let ny = (x2 - x1) / dist;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const lift = Math.min(160, dist * 0.28);
  const cxp = mx + nx * lift;
  const cyp = my + ny * lift;
  const len = Math.round(dist * 1.12);
  return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cxp.toFixed(1)} ${cyp.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`, len };
}

function Graticule() {
  const lines = [];
  for (let lon = -75; lon <= 120; lon += 15) {
    const [x] = project(lon, 0);
    lines.push(<line key={`m${lon}`} x1={x} x2={x} y1={0} y2={ATLAS.h} />);
  }
  for (let lat = 30; lat <= 60; lat += 10) {
    const [, y] = project(0, lat);
    lines.push(<line key={`p${lat}`} x1={0} x2={ATLAS.w} y1={y} y2={y} />);
  }
  return (
    <g stroke="currentColor" strokeWidth="1" className="text-paper/[0.09]" strokeDasharray="2 6">
      {lines}
      {[30, 40, 50, 60].map((lat) => {
        const [, y] = project(0, lat);
        return (
          <text key={lat} x={8} y={y - 6} className="fill-paper/30 font-mono text-[11px]" stroke="none">
            {lat}°N
          </text>
        );
      })}
    </g>
  );
}

/**
 * The Money Atlas map.
 * variant 'full': interactive corridors from `origin` with selection and history.
 * variant 'ambient': decorative, non-interactive routes for the login and overview.
 */
/** On narrow screens the map keeps a readable size and scrolls sideways, starting centred on the origin. */
function AtlasFrame({ origin, children, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const from = placeFor(origin) ?? ATLAS_PLACES[0];
    const [x] = project(from.lon, from.lat);
    el.scrollLeft = (x / ATLAS.w) * el.scrollWidth - el.clientWidth * 0.6;
  }, [origin]);
  return (
    <div ref={ref} className={cx('overflow-x-auto overscroll-x-contain [scrollbar-width:thin]', className)}>
      <div className="min-w-[46rem] md:min-w-0">{children}</div>
    </div>
  );
}

function AtlasMap({ origin, selected, onSelect, corridors = [], variant = 'full', destinations, className }) {
  const reduced = usePrefersReducedMotion();
  const from = placeFor(origin) ?? ATLAS_PLACES[0];
  const dests = (destinations ?? ATLAS_PLACES.map((p) => p.currency)).filter((c) => c !== from.currency).map(placeFor).filter(Boolean);
  const interactive = variant === 'full';
  const history = Object.fromEntries(corridors.filter((c) => c.from === from.currency).map((c) => [c.to, c.count]));
  const [fx, fy] = project(from.lon, from.lat);

  return (
    <svg viewBox={`0 0 ${ATLAS.w} ${ATLAS.h}`} className={cx('block w-full', className)} role={interactive ? 'group' : 'img'} aria-label={interactive ? `Money Atlas: corridors from ${from.city}` : 'Abstract map of money routes between countries'}>
      <Graticule />
      {dests.map((p) => {
        const r = routePath(from, p);
        const active = selected === p.currency;
        const hasHistory = history[p.currency] > 0;
        return (
          <g key={`r-${p.id}`}>
            <path d={r.d} fill="none" stroke="currentColor" className={cx(active ? 'text-lime' : hasHistory ? 'text-paper/55' : 'text-paper/25')} strokeWidth={active ? 2.5 : hasHistory ? 1.6 : 1.2} strokeDasharray={active ? undefined : '5 6'} />
            {active ? <path key={`draw-${origin}-${p.currency}`} d={r.d} fill="none" stroke="var(--color-lime)" strokeWidth="2.5" className="draw-path" style={{ '--len': r.len }} /> : null}
            {!reduced && (active || variant === 'ambient') ? (
              <circle r={active ? 4.5 : 3.5} fill="var(--color-lime)">
                <animateMotion dur={`${2.2 + (Math.abs(p.lon) % 3) * 0.3}s`} repeatCount="indefinite" path={r.d} />
              </circle>
            ) : null}
          </g>
        );
      })}
      {dests.map((p) => {
        const [x, y] = project(p.lon, p.lat);
        const active = selected === p.currency;
        const pos = LABEL_POS[p.id];
        const count = history[p.currency];
        const body = (
          <>
            <circle cx={x} cy={y} r="18" fill="transparent" />
            <circle cx={x} cy={y} r={active ? 6.5 : 4.5} className={active ? 'fill-lime' : 'fill-paper'} />
            <text x={x + pos.dx} y={y + pos.dy} textAnchor={pos.anchor} className={cx('font-sans text-[15px] font-medium', active ? 'fill-lime' : 'fill-paper')}>
              {p.city}
            </text>
            <text x={x + pos.dx} y={y + pos.dy + 15} textAnchor={pos.anchor} className="fill-paper/55 font-mono text-[11.5px]">
              {p.currency}
              {count ? `  ${count} simulated` : ''}
            </text>
          </>
        );
        return interactive ? (
          <g
            key={p.id}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={`${p.city}, ${p.country}: ${p.currency}${count ? `, ${count} simulated transfers` : ''}`}
            onClick={() => onSelect?.(p.currency)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.(p.currency);
              }
            }}
            className="cursor-pointer outline-none [&:focus-visible>circle:nth-child(2)]:stroke-lime [&:focus-visible>circle:nth-child(2)]:stroke-[3px]"
          >
            {body}
          </g>
        ) : (
          <g key={p.id}>{body}</g>
        );
      })}
      <g>
        <circle cx={fx} cy={fy} r="5" fill="var(--color-lime)" className="ping" />
        <circle cx={fx} cy={fy} r="9" fill="none" stroke="var(--color-lime)" strokeWidth="2" />
        <circle cx={fx} cy={fy} r="3.5" fill="var(--color-lime)" />
        <text x={fx + LABEL_POS[from.id].dx + 4} y={fy + LABEL_POS[from.id].dy} textAnchor={LABEL_POS[from.id].anchor} className="fill-lime font-sans text-[15px] font-semibold">
          {from.city}
        </text>
        <text x={fx + LABEL_POS[from.id].dx + 4} y={fy + LABEL_POS[from.id].dy + 15} textAnchor={LABEL_POS[from.id].anchor} className="fill-lime/70 font-mono text-[11.5px]">
          {from.currency} home
        </text>
      </g>
    </svg>
  );
}

// ===========================================================================
// Brand, navigation, shell
// ===========================================================================

function BrandMark({ className = 'size-8', dark }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="7" fill={dark ? 'var(--color-lime)' : 'var(--color-forest)'} />
      <path d="M5 21h22M8 21c2.5-7 13.5-7 16 0M12 21v-4.2M16 21v-5.5M20 21v-4.2" fill="none" stroke={dark ? 'var(--color-forest)' : 'var(--color-lime)'} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Wordmark({ to = '/', dark }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 rounded-[var(--radius-ctl)]" aria-label="CampusBridge AI, overview">
      <BrandMark dark={dark} />
      <span className={cx('font-display text-[1.375rem] leading-none tracking-[-0.02em]', dark ? 'text-paper' : 'text-ink')} style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 50", fontWeight: 420 }}>
        CampusBridge
      </span>
    </Link>
  );
}

const NAV = [
  { to: '/', label: 'Overview', hint: 'Balance, tuition and what is next', end: true },
  { to: '/atlas', label: 'Money Atlas', hint: 'Corridors between your currencies' },
  { to: '/budget', label: 'Budgets', hint: 'Income, expenses and bills' },
  { to: '/savings', label: 'Tuition goals', hint: 'Target, deadline and pace' },
  { to: '/transfers', label: 'Transfers', hint: 'Compare and simulate routes' },
  { to: '/intelligence', label: 'Bridge Intelligence', hint: 'Ask, review and confirm tasks' },
  { to: '/activity', label: 'Activity', hint: 'Audit trail of every action' },
  { to: '/settings', label: 'Settings', hint: 'Currencies, support and data' },
];

function Masthead() {
  const { user } = useAuth();
  const index = useRef(null);
  const close = () => index.current?.close();
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ink/12 bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-[90rem] items-center gap-6 px-4 sm:px-8">
          <Wordmark />
          <nav aria-label="Main" className="hidden flex-1 justify-center xl:flex">
            <ul className="flex items-center gap-0.5">
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    end={n.end}
                    className={({ isActive }) =>
                      cx('inline-flex min-h-9 items-center rounded-[var(--radius-ctl)] px-2.5 text-[0.84rem] font-medium whitespace-nowrap transition-colors', isActive ? 'bg-lime text-ink' : 'text-ink-3 hover:text-ink')
                    }
                  >
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2 xl:ml-0">
            <Link to="/settings" className="hidden items-center gap-2 rounded-full py-1 pr-1 pl-3 text-sm text-ink-2 hover:bg-paper-2 sm:flex xl:pl-1" aria-label={`Settings for ${user?.name}`}>
              <span className="xl:sr-only">{firstName(user?.name)}</span>
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-forest font-display text-sm text-lime">
                {(user?.name ?? '?').charAt(0).toUpperCase()}
              </span>
            </Link>
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => index.current?.showModal()}
              className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] border border-ink/20 px-3 text-sm font-medium hover:border-ink xl:hidden"
            >
              <Menu aria-hidden="true" className="size-4" /> Menu
            </button>
          </div>
        </div>
      </header>
      <dialog ref={index} aria-label="Menu" className="on-dark m-0 h-dvh max-h-none w-screen max-w-none bg-forest p-0 text-paper" onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="mx-auto flex min-h-full max-w-[90rem] flex-col px-4 py-5 sm:px-8">
          <div className="flex items-center justify-between">
            <span onClick={close}>
              <Wordmark dark />
            </span>
            <button type="button" aria-label="Close menu" onClick={close} className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] border border-paper/30 px-3 text-sm hover:border-paper">
              <X aria-hidden="true" className="size-4" /> Close
            </button>
          </div>
          <nav aria-label="Main" className="mt-10 flex-1">
            <ul className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
              {NAV.map((n) => (
                <li key={n.to} className="border-b border-paper/15">
                  <NavLink to={n.to} end={n.end} onClick={close} className={({ isActive }) => cx('group flex items-baseline justify-between gap-4 py-4', isActive ? 'text-lime' : 'text-paper hover:text-lime')}>
                    <span className="font-display text-[2rem] leading-none sm:text-[2.5rem]">{n.label}</span>
                    <span className="hidden text-sm text-mist sm:inline">{n.hint}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <p className="mt-8 text-sm text-mist">Signed in as {user?.email}</p>
        </div>
      </dialog>
    </>
  );
}

function SandboxStrip() {
  return (
    <div className="sim-dash border-b border-ink/25 bg-paper-2">
      <p className="mx-auto max-w-[90rem] px-4 py-2 text-[0.8125rem] text-ink-2 sm:px-8">
        <span className="font-semibold text-ink">Sandbox.</span> Exchange rates are illustrative ({formatRate(midRate('AZN', 'EUR'), 'AZN', 'EUR')}, not live) and transfers are simulated. No real money moves.
      </p>
    </div>
  );
}

const TITLES = Object.fromEntries(NAV.map((n) => [n.to, n.label]));

function AppShell() {
  const location = useLocation();
  useEffect(() => {
    document.title = `${TITLES[location.pathname] ?? 'CampusBridge AI'} — CampusBridge AI`;
    window.scrollTo(0, 0);
    const h = document.querySelector('[data-page-title]');
    if (h && document.activeElement?.tagName !== 'INPUT') h.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <WorkspaceProvider>
      <div className="flex min-h-dvh flex-col">
        <Masthead />
        <SandboxStrip />
        <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 pb-20 sm:px-8">
          <WorkspaceGate />
        </main>
        <footer className="border-t border-ink/12">
          <div className="mx-auto flex max-w-[90rem] flex-wrap justify-between gap-4 px-4 py-6 text-xs text-ink-3 sm:px-8">
            <p>CampusBridge AI, Topic C: Cross-border and Student Finance. A prototype with fictional or user-entered data.</p>
            <p>Not a bank, payment institution or credit provider. Not financial advice.</p>
          </div>
        </footer>
      </div>
    </WorkspaceProvider>
  );
}

function WorkspaceGate() {
  const { ws, error, reload } = useWorkspace();
  const { pathname } = useLocation();
  const [retrying, setRetrying] = useState(false);
  if (!ws && error) {
    return (
      <div className="py-12">
        <Notice
          tone="danger"
          title="Your workspace could not be loaded"
          action={
            <Button
              variant="outline"
              icon={RefreshCw}
              busy={retrying}
              onClick={async () => {
                setRetrying(true);
                await reload();
                setRetrying(false);
              }}
            >
              Try again
            </Button>
          }
        >
          {error}
        </Notice>
      </div>
    );
  }
  if (!ws) return <PageSkeleton />;
  return (
    <>
      {error ? (
        <Notice tone="danger" className="mt-6" title="Latest changes could not be refreshed">
          {error}
        </Notice>
      ) : null}
      <div key={pathname} className="rise">
        <Outlet />
      </div>
    </>
  );
}

// ===========================================================================
// Authentication
// ===========================================================================

const DEMO = { email: 'demo@campusbridge.test', password: 'CampusBridge-demo-2026' };

function AuthLayout({ children }) {
  const example = compareTransfer({ amount: 1150, from: 'AZN', to: 'EUR' }).quotes.find((q) => q.isBest);
  const parts = moneyParts(example.receiveAmount, 'EUR');
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="on-dark relative flex flex-col overflow-hidden bg-forest px-5 pt-6 pb-8 text-paper sm:px-10 lg:min-h-dvh lg:px-14 lg:pt-10 lg:pb-12">
        <Wordmark to="/login" dark />
        <div className="mt-10 lg:mt-auto">
          <h2 className="max-w-[13ch] text-[2.5rem] leading-[0.98] text-paper sm:text-[3.5rem] xl:text-[4.75rem]">Your world is bigger than one currency.</h2>
          <p className="mt-5 max-w-[46ch] text-[1.0625rem] text-mist">One intelligent workspace for the money, goals and decisions that move with you.</p>
        </div>
        <div className="-mx-5 mt-8 hidden sm:-mx-10 sm:block lg:-mx-14">
          <AtlasMap origin="AZN" variant="ambient" destinations={['EUR', 'CNY', 'GBP', 'USD']} className="max-h-[22rem]" />
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-6 border-t border-paper/15 pt-5">
          <div>
            <p className="numeral text-[3rem] text-lime sm:text-[4rem]">
              {parts.symbol}
              {parts.int}
              <span className="text-[0.5em]">.{parts.dec}</span>
            </p>
            <p className="mt-2 max-w-[38ch] text-sm text-mist">
              What 1,150 AZN of monthly support could become in Berlin through the cheapest demo route. A fictional example at an illustrative rate.
            </p>
          </div>
          <SimTag dark>Illustrative figures</SimTag>
        </div>
      </section>
      <section className="flex flex-col justify-center bg-paper px-5 py-12 sm:px-10 lg:px-16">
        <div className="mx-auto w-full max-w-[26rem]">{children}</div>
      </section>
    </div>
  );
}

function PasswordField({ label, error, hint, value, onChange, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      {(a) => (
        <div className="relative">
          <input {...a} type={show ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} className={cx(a.className, 'pr-11')} />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center text-ink-3 hover:text-ink"
          >
            {show ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          </button>
        </div>
      )}
    </Field>
  );
}

function OfflineNotice() {
  const auth = useAuth();
  if (auth.status !== 'offline') return null;
  return (
    <Notice tone="danger" className="mb-6" title="Server unavailable" action={<Button variant="outline" size="sm" icon={RefreshCw} onClick={auth.retry}>Try again</Button>}>
      {auth.notice} Start it with <code className="font-mono text-[0.8125rem]">npm start</code> in the project folder.
    </Notice>
  );
}

function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    document.title = 'Sign in — CampusBridge AI';
  }, []);
  if (auth.user) return <Navigate to={location.state?.from ?? '/'} replace />;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <OfflineNotice />
      <h1 data-page-title tabIndex={-1} className="text-[2.75rem] leading-none outline-none">
        Sign in
      </h1>
      <p className="mt-3 text-ink-2">Pick up where you left off. Your workspace is private to your account.</p>
      {auth.notice && auth.status !== 'offline' ? (
        <Notice className="mt-6" tone="success">
          {auth.notice}
        </Notice>
      ) : null}
      <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" size="lg" busy={busy} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-sm text-ink-2">
        New here?{' '}
        <Link to="/register" className="font-semibold text-forest underline underline-offset-4">
          Create an account
        </Link>
      </p>
      <div className="sim-dash mt-10 rounded-[var(--radius-panel)] border border-ink/30 p-4 text-sm">
        <p className="font-semibold">Fictional demo account</p>
        <p className="mt-1 text-ink-2">
          Three months of sample data for an Azerbaijani student in Germany. Email <span className="font-mono text-[0.8125rem] text-ink">{DEMO.email}</span>, password{' '}
          <span className="font-mono text-[0.8125rem] text-ink">{DEMO.password}</span>.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => {
            setEmail(DEMO.email);
            setPassword(DEMO.password);
          }}
        >
          Fill in demo details
        </Button>
      </div>
    </AuthLayout>
  );
}

function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', sampleData: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  useEffect(() => {
    document.title = 'Create account — CampusBridge AI';
  }, []);
  if (auth.user) return <Navigate to="/" replace />;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await auth.register(form);
      navigate('/', { replace: true });
    } catch (err) {
      setFields(err.fields ?? {});
      setError(err.fields ? null : err.message);
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <OfflineNotice />
      <h1 data-page-title tabIndex={-1} className="text-[2.75rem] leading-none outline-none">
        Create your account
      </h1>
      <p className="mt-3 text-ink-2">Your password is hashed on the server and never stored as text.</p>
      <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
        <TextField label="Name" autoComplete="name" value={form.name} onChange={set('name')} error={fields.name} maxLength={60} />
        <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={fields.email} />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          error={fields.password}
          hint={`At least ${LIMITS.password.min} characters, with a letter and a number.`}
        />
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" checked={form.sampleData} onChange={set('sampleData')} className="mt-0.5 size-4 accent-forest" />
          <span>
            <span className="font-semibold">Start with fictional sample data</span>
            <span className="block text-ink-3">Three months of example records you can edit or clear later.</span>
          </span>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button type="submit" size="lg" busy={busy} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-6 text-sm text-ink-2">
        Already registered?{' '}
        <Link to="/login" className="font-semibold text-forest underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') {
    return (
      <div role="status" className="grid min-h-dvh place-items-center bg-paper text-ink-3">
        <span className="flex items-center gap-3">
          <BrandMark /> Opening your workspace…
        </span>
      </div>
    );
  }
  if (!auth.user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <AppShell />;
}

// ===========================================================================
// Shared financial widgets
// ===========================================================================

const CATEGORY_ICON = {
  Housing: Home,
  'Food & groceries': ShoppingBasket,
  Transport: Bus,
  Education: BookOpen,
  'Health & insurance': HeartPulse,
  'Phone & internet': Smartphone,
  Leisure: Sparkles,
};

function TxGlyph({ t }) {
  const Icon = t.type === 'expense' ? (CATEGORY_ICON[t.category] ?? Wallet) : t.type === 'savings_contribution' ? PiggyBank : t.type.startsWith('transfer') ? ArrowLeftRight : ArrowDownLeft;
  return (
    <span className={cx('grid size-9 shrink-0 place-items-center rounded-full', t.simulated ? 'sim-dash border border-ink/40 text-ink-2' : t.type === 'expense' ? 'bg-paper-2 text-ink-2' : 'bg-forest text-lime')}>
      <Icon aria-hidden="true" className="size-4" />
    </span>
  );
}

const TYPE_LABEL = {
  expense: 'Expense',
  income: 'Income',
  opening_balance: 'Opening balance',
  transfer_out: 'Simulated transfer out',
  transfer_in: 'Simulated transfer in',
  savings_contribution: 'To tuition savings',
};

function signed(t) {
  const neg = ['expense', 'transfer_out', 'savings_contribution'].includes(t.type);
  return { neg, text: `${neg ? '−' : '+'}${formatMoney(t.amount, '')}` };
}

function LedgerRow({ t, actions }) {
  const a = signed(t);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3">
      <TxGlyph t={t} />
      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] font-medium">{t.description}</p>
        <p className="flex flex-wrap items-center gap-x-3 text-[0.8125rem] text-ink-3">
          <span className="font-mono text-[0.75rem]">{t.occurredOn}</span>
          <span>{t.simulated ? 'Simulated' : (t.category ?? TYPE_LABEL[t.type])}</span>
          {t.createdBy === 'assistant' ? <span>via Bridge Intelligence</span> : null}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className={cx('tabular text-right text-[0.9375rem] font-medium whitespace-nowrap', !a.neg && 'text-forest')}>
          {a.text}
          <span className="ml-1.5 font-mono text-[0.6875rem] text-ink-3">{t.currency}</span>
        </p>
        {actions}
      </div>
    </li>
  );
}

/** Balance history sparkline (single series, so no legend: the label names it). */
function Sparkline({ points, currency }) {
  const [hover, setHover] = useState(null);
  const W = 320;
  const H = 72;
  const vals = points.map((p) => p.total);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 1);
  const xy = points.map((p, i) => [8 + (i / (points.length - 1)) * (W - 16), 8 + (1 - (p.total - min) / (max - min || 1)) * (H - 24)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[22rem] overflow-visible" role="img" aria-label={`Total available at each month end: ${points.map((p) => `${p.date} ${formatMoney(p.total, currency)}`).join('; ')}`}>
        <path d={d} fill="none" stroke="var(--color-ink)" strokeWidth="2" strokeLinejoin="round" className="draw-path" style={{ '--len': 600 }} />
        {xy.map(([x, y], i) => (
          <g key={points[i].date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={x} cy={y} r="14" fill="transparent" />
            <circle cx={x} cy={y} r={i === xy.length - 1 ? 5 : 3} fill={i === xy.length - 1 ? 'var(--color-lime)' : 'var(--color-ink)'} stroke="var(--color-ink)" strokeWidth={i === xy.length - 1 ? 2 : 0} />
          </g>
        ))}
        {points.map((p, i) =>
          i === 0 || i === points.length - 1 ? (
            <text key={p.date} x={xy[i][0]} y={H} textAnchor={i === 0 ? 'start' : 'end'} className="fill-ink-3 font-mono text-[10px]">
              {i === points.length - 1 ? 'today' : formatMonth(monthKey(p.date)).replace(/ \d+$/, '')}
            </text>
          ) : null,
        )}
      </svg>
      {hover !== null ? (
        <figcaption role="tooltip" className="pointer-events-none absolute -top-9 rounded-[var(--radius-ctl)] bg-ink px-2.5 py-1 text-xs whitespace-nowrap text-paper" style={{ left: `${(xy[hover][0] / W) * 100}%`, transform: 'translateX(-50%)' }}>
          <span className="font-mono">{points[hover].date}</span> {formatMoney(points[hover].total, currency)}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Circular progress arc; animates when the value changes. */
function ProgressArc({ value, size = 168, stroke = 10, dark = true, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(Math.max(0, Math.min(1, value))), 60);
    return () => window.clearTimeout(t);
  }, [value]);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? 'rgb(245 242 234 / 0.15)' : 'rgb(23 25 22 / 0.1)'} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-lime)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          style={{ transition: 'stroke-dashoffset 1.1s var(--ease-out-quint)' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

/** Spending by category: bar = this month, tick = monthly budget, ring = last month to the same day. */
function CategoryBars({ spending, previous, currency, compact }) {
  const rows = spending.rows.filter((r) => r.spent > 0 || r.limit > 0 || (previous?.rows.find((p) => p.category === r.category)?.spent ?? 0) > 0);
  const prev = Object.fromEntries((previous?.rows ?? []).map((r) => [r.category, r.spent]));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.spent, r.limit, prev[r.category] ?? 0)));
  if (!rows.length) return <Empty title="Nothing spent yet">Expenses you add appear here by category.</Empty>;
  return (
    <div>
      <ul className="space-y-3.5">
        {rows.map((r, i) => {
          const before = prev[r.category] ?? 0;
          return (
            <li key={r.category} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_7.5rem]">
              <span className="truncate text-sm text-ink-2">{r.category}</span>
              <span className="relative h-3" title={`${r.category}: ${formatMoney(r.spent, currency)} spent${r.limit ? ` of ${formatMoney(r.limit, currency)}` : ''}; last month to date ${formatMoney(before, currency)}`}>
                <span className="absolute inset-y-[5px] left-0 w-full rounded-full bg-ink/8" />
                <span className={cx('grow-x absolute inset-y-0 left-0 rounded-r-[4px]', r.over ? 'bg-coral' : 'bg-ink')} style={{ width: `${(r.spent / max) * 100}%`, animationDelay: `${i * 40}ms` }} />
                {r.limit ? <span aria-hidden="true" className="absolute -inset-y-1 w-[2px] bg-forest" style={{ left: `calc(${(r.limit / max) * 100}% - 1px)` }} /> : null}
                {previous && before > 0 ? (
                  <span aria-hidden="true" className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-forest bg-paper" style={{ left: `${(before / max) * 100}%` }} />
                ) : null}
              </span>
              <span className="tabular text-right text-sm">
                {formatMoney(r.spent, '')}
                {r.over ? <span className="block text-xs font-medium text-coral-ink">over by {formatMoney(r.spent - r.limit, '')}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {!compact ? (
        <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-3">
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-5 rounded-r bg-ink" /> This month, in {currency}
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="h-3.5 w-[2px] bg-forest" /> Monthly budget
          </li>
          {previous ? (
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-forest" /> Last month to the same day
            </li>
          ) : null}
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-5 rounded-r bg-coral" /> Over budget
          </li>
        </ul>
      ) : null}
      <div className="sr-only">
      <table>
        <caption>Spending by category in {currency}</caption>
        <thead>
          <tr>
            <th>Category</th>
            <th>This month</th>
            <th>Budget</th>
            <th>Last month to date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category}>
              <th scope="row">{r.category}</th>
              <td>{formatMoney(r.spent, currency)}</td>
              <td>{r.limit ? formatMoney(r.limit, currency) : 'none'}</td>
              <td>{formatMoney(prev[r.category] ?? 0, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Path to the tuition target: planned pace vs the pace needed to finish on time. */
function TuitionPath({ plan, today, height = 220 }) {
  const [hover, setHover] = useState(null);
  const months = Math.max(1, plan.monthsLeft + 1);
  const pts = Array.from({ length: months + 1 }, (_, i) => ({
    i,
    date: addMonths(today, i),
    planned: Math.min(plan.target, plan.saved + plan.plannedMonthly * i),
    needed: Math.min(plan.target, plan.saved + plan.requiredMonthly * i),
  }));
  const W = 640;
  const H = height;
  const pad = { l: 8, r: 8, t: 18, b: 26 };
  const x = (i) => pad.l + (i / months) * (W - pad.l - pad.r);
  const yMin = Math.max(0, Math.floor((plan.saved * 0.8) / 100) * 100);
  const y = (v) => pad.t + (1 - (v - yMin) / (plan.target - yMin || 1)) * (H - pad.t - pad.b);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(' ');
  const deadlineX = x(Math.min(months, plan.monthsLeft + (plan.daysLeft > 0 ? 0.5 : 0)));
  return (
    <figure>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={`Tuition path: saved ${formatMoney(plan.saved, plan.currency)} now, target ${formatMoney(plan.target, plan.currency)} by ${plan.deadline}.`}>
          <line x1={pad.l} x2={W - pad.r} y1={y(plan.target)} y2={y(plan.target)} stroke="var(--color-ink)" strokeWidth="1" />
          <text x={pad.l} y={y(plan.target) - 6} className="fill-ink-3 text-[11px]">
            Target {formatMoney(plan.target, plan.currency)}
          </text>
          <line x1={deadlineX} x2={deadlineX} y1={pad.t - 6} y2={H - pad.b} stroke="var(--color-coral-ink)" strokeDasharray="3 4" />
          <text x={deadlineX - 6} y={H - pad.b - 8} textAnchor="end" className="fill-coral-ink text-[11px]">
            Deadline {formatDate(plan.deadline)}
          </text>
          <path d={line('needed')} fill="none" stroke="var(--color-forest)" strokeWidth="2" strokeDasharray="6 5" />
          <path d={line('planned')} fill="none" stroke="var(--color-ink)" strokeWidth="2.5" className="draw-path" style={{ '--len': 900 }} />
          {pts.map((p) => (
            <g key={p.i} onMouseEnter={() => setHover(p.i)} onMouseLeave={() => setHover(null)}>
              <rect x={x(p.i) - 14} y={0} width={28} height={H} fill="transparent" />
              <circle cx={x(p.i)} cy={y(p.planned)} r={hover === p.i ? 5 : 3} fill="var(--color-ink)" />
              <text x={x(p.i)} y={H - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[10px]">
                {formatMonth(monthKey(p.date)).slice(0, 3)}
              </text>
            </g>
          ))}
          <circle cx={x(0)} cy={y(plan.saved)} r="6" fill="var(--color-lime)" stroke="var(--color-ink)" strokeWidth="2" />
          <text x={pad.l + 12} y={y(plan.saved) + 18} className="fill-ink-3 text-[11px]">
            {formatMoney(plan.saved, plan.currency)} saved
          </text>
        </svg>
        {hover !== null ? (
          <div role="tooltip" className="pointer-events-none absolute top-0 rounded-[var(--radius-ctl)] bg-ink px-3 py-2 text-xs whitespace-nowrap text-paper" style={{ left: `${(x(hover) / W) * 100}%`, transform: 'translateX(-50%)' }}>
            <p className="font-mono">{formatMonth(monthKey(pts[hover].date))}</p>
            <p>Your plan: {formatMoney(pts[hover].planned, plan.currency)}</p>
            <p>Needed pace: {formatMoney(pts[hover].needed, plan.currency)}</p>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-3">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-[3px] w-6 bg-ink" /> Your plan, {formatMoney(plan.plannedMonthly, plan.currency)} a month
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="w-6 border-t-2 border-dashed border-forest" /> Needed pace, {formatMoney(plan.requiredMonthly, plan.currency)} a month
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-3 rounded-full border-2 border-ink bg-lime" /> Saved today
        </span>
      </figcaption>
    </figure>
  );
}

// ===========================================================================
// Dialogs used from several views
// ===========================================================================

const emptyEntry = (cur, today) => ({ type: 'expense', amount: '', currency: cur, category: EXPENSE_CATEGORIES[1], description: '', occurredOn: today });

function TransactionDialog({ initial, onClose }) {
  const { mutate } = useWorkspace();
  const { notify } = useToast();
  const [form, setForm] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (initial !== seen) {
    setSeen(initial);
    setForm(initial);
    setFields({});
    setError(null);
  }
  const open = Boolean(initial);
  const editing = Boolean(form?.id);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setType = (type) => setForm((f) => ({ ...f, type, category: type === 'expense' ? EXPENSE_CATEGORIES[1] : INCOME_CATEGORIES[0] }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFields({});
    setError(null);
    try {
      const body = { type: form.type, amount: form.amount, currency: form.currency, category: form.category, description: form.description, occurredOn: form.occurredOn };
      await mutate(() => (editing ? api(`/transactions/${form.id}`, { method: 'PUT', body }) : api('/transactions', { method: 'POST', body })));
      notify(editing ? 'Transaction updated.' : `${form.type === 'expense' ? 'Expense' : 'Income'} added.`);
      onClose();
    } catch (err) {
      setFields(err.fields ?? {});
      if (!err.fields) setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={editing ? 'Edit transaction' : form?.type === 'income' ? 'Add income' : 'Add expense'} description="Saved to your account and recorded in your activity.">
      {form ? (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Tabs
            label="Type"
            value={form.type}
            onChange={setType}
            options={[
              { value: 'expense', label: 'Expense' },
              { value: 'income', label: 'Income' },
            ]}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <MoneyField label="Amount" value={form.amount} onChange={set('amount')} error={fields.amount} placeholder="0.00" />
            <SelectField label="Currency" value={form.currency} onChange={set('currency')} error={fields.currency} options={CURRENCIES.map((x) => x.code)} />
          </div>
          <SelectField label="Category" value={form.category} onChange={set('category')} error={fields.category} options={form.type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES} />
          <TextField label="Description" value={form.description} onChange={set('description')} error={fields.description} maxLength={LIMITS.text} placeholder={form.type === 'expense' ? 'Weekly groceries' : 'Support from family'} />
          <TextField label="Date" type="date" value={form.occurredOn} onChange={set('occurredOn')} error={fields.occurredOn} max={todayLocal()} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              {editing ? 'Save changes' : form.type === 'income' ? 'Add income' : 'Add expense'}
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

function ContributionDialog({ open, onClose, sandbox }) {
  const { ws } = useWorkspace();
  const s = ws.computed.savings;
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  if (!s) {
    return (
      <Dialog open={open} onClose={onClose} title="Add to tuition savings">
        <Empty title="No tuition goal yet" action={<Link to="/savings" onClick={onClose} className="font-semibold text-forest underline underline-offset-4">Set a goal first</Link>}>
          Contributions go towards a goal with a target and deadline.
        </Empty>
      </Dialog>
    );
  }
  const wallet = ws.computed.balances.find((b) => b.currency === s.currency)?.amount ?? 0;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const ok = await sandbox.propose('savings_contribution', { amount, currency: s.currency });
    setBusy(false);
    if (ok) {
      setAmount('');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add to tuition savings" description={`From your ${s.currency} wallet, which holds ${formatMoney(wallet, s.currency)}.`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <MoneyField label={`Amount in ${s.currency}`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(Math.round(s.requiredMonthly))} />
        <div className="flex flex-wrap gap-2">
          {[s.plannedMonthly, s.requiredMonthly]
            .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
            .map((v) => (
              <Button key={v} size="sm" variant="outline" onClick={() => setAmount(String(Math.min(v, s.remaining)))}>
                {formatMoney(Math.min(v, s.remaining), s.currency)}
              </Button>
            ))}
        </div>
        <p className="text-sm text-ink-3">Next you will see the before and after, then confirm. This updates your records only.</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!amount.trim()}>
            Review contribution
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ===========================================================================
// Overview
// ===========================================================================

function BalanceFigure({ value, currency }) {
  const shown = useCountUp(value);
  const p = moneyParts(shown, currency);
  return (
    <p className="numeral text-[4.25rem] text-ink sm:text-[7rem] xl:text-[9.5rem]" aria-label={formatMoney(value, currency)}>
      <span aria-hidden="true">
        {p.sign}
        <span className="align-[0.42em] text-[0.62em]">{p.symbol}</span>
        {p.int}
        <span className="ml-[0.04em] align-[0.95em] text-[0.34em] tracking-normal text-ink-3">.{p.dec}</span>
      </span>
    </p>
  );
}

function OverviewPage() {
  const { user } = useAuth();
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const navigate = useNavigate();
  const sandbox = useSandboxAction();
  const [txDialog, setTxDialog] = useState(null);
  const [contrib, setContrib] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = ws.computed;
  const cur = c.currency;
  const s = c.savings;
  const f = c.forecast;
  const empty = ws.transactions.length === 0 && !ws.goal;
  const support = ws.profile.monthlySupport > 0 && ws.profile.homeCurrency !== cur ? compareTransfer({ amount: ws.profile.monthlySupport, from: ws.profile.homeCurrency, to: cur }) : null;
  const supportBest = support?.quotes.find((q) => q.isBest);
  const diff = round2(c.spending.spent - c.spendingPrevToDate.spent);
  const day = Number(ws.today.slice(8, 10));

  const loadSample = async () => {
    setBusy(true);
    try {
      await mutate(() => api('/workspace/sample', { method: 'POST', body: { confirm: true } }));
      notify('Fictional sample data loaded into your workspace.');
      setSampleOpen(false);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const actions = [
    { label: 'Add expense', note: 'Record what you spent, in any currency', onClick: () => setTxDialog(emptyEntry(cur, ws.today)) },
    { label: 'Add savings', note: 'Move money towards tuition', onClick: () => setContrib(true) },
    { label: 'Compare transfers', note: 'Four simulated routes side by side', onClick: () => navigate('/transfers') },
    { label: 'Ask Bridge Intelligence', note: 'Plan, forecast or simulate a task', onClick: () => navigate('/intelligence') },
  ];

  return (
    <>
      <h1 data-page-title tabIndex={-1} className="sr-only outline-none">
        Overview
      </h1>

      <section aria-label="Balance and tuition" className="grid grid-cols-1 gap-y-10 pt-10 sm:pt-14 lg:grid-cols-12 lg:gap-x-10">
        <div className="min-w-0 lg:col-span-8">
          <p className="text-[0.9375rem] text-ink-2">
            {firstName(user.name)}, this is what you have available today across all wallets{ws.profile.sampleData ? ' (fictional sample data)' : ''}.
          </p>
          <BalanceFigure value={c.totalAvailable} currency={cur} />
          <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-6">
            <div>
              <p className={cx('text-[1.0625rem] font-medium', c.monthChange >= 0 ? 'text-forest' : 'text-coral-ink')}>
                {c.monthChange >= 0 ? <ArrowUpRight aria-hidden="true" className="mr-1 inline size-4 align-[-2px]" /> : <ArrowDownLeft aria-hidden="true" className="mr-1 inline size-4 align-[-2px]" />}
                {c.monthChange >= 0 ? '+' : '−'}
                {formatMoney(Math.abs(c.monthChange), cur)} since {formatDate(c.balanceHistory.at(-2).date)}
              </p>
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-3">
                {c.balances.map((b) => (
                  <li key={b.currency}>
                    <span className="tabular text-ink">{formatMoney(b.amount, '')}</span> <span className="font-mono text-xs">{b.currency}</span> wallet
                  </li>
                ))}
                {!c.balances.length ? <li>No balances yet</li> : null}
              </ul>
            </div>
            {c.balanceHistory.some((p) => p.total !== 0) ? (
              <div className="min-w-[14rem] flex-1">
                <p className="mb-1 text-xs text-ink-3">Total available at each month end, in {cur}</p>
                <Sparkline points={c.balanceHistory} currency={cur} />
              </div>
            ) : null}
          </div>
        </div>

        <aside aria-label="Tuition savings" className="on-dark relative overflow-hidden rounded-[var(--radius-panel)] bg-forest p-6 text-paper sm:p-8 lg:col-span-4 lg:self-start">
          {s ? (
            <>
              <p className="text-sm text-mist">Kept apart for tuition, not counted above</p>
              <div className="mt-5 flex items-center gap-6">
                <ProgressArc value={s.progress} size={150}>
                  <span className="numeral text-[2.75rem] text-paper">
                    {Math.round(s.progress * 100)}
                    <span className="text-[0.5em]">%</span>
                  </span>
                </ProgressArc>
                <div className="min-w-0">
                  <p className="numeral text-[2.25rem] text-lime">{formatMoney(s.saved, '')}</p>
                  <p className="mt-1 text-sm text-mist">
                    of {formatMoney(s.target, s.currency)} for {s.name}
                  </p>
                </div>
              </div>
              <Rows
                dark
                className="mt-6"
                rows={[
                  ['Due', formatDate(s.deadline)],
                  ['Needed each month', formatMoney(s.requiredMonthly, s.currency), { strong: true }],
                  ['Status', SAVINGS_STATUS[s.status], { tone: s.status === 'behind' ? 'coral' : undefined }],
                ]}
              />
              <Link to="/savings" className="mt-5 inline-block text-sm font-medium text-lime underline-offset-4 hover:underline">
                Open tuition goals
              </Link>
            </>
          ) : (
            <Empty dark title="No tuition goal yet" action={<Button variant="lime" onClick={() => navigate('/savings')}>Set a goal</Button>}>
              Add your tuition target and deadline to see your pace.
            </Empty>
          )}
        </aside>
      </section>

      <section aria-label="Quick actions" className="mt-12 grid grid-cols-1 border-y border-ink/15 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map((a, i) => (
          <button
            key={a.label}
            type="button"
            onClick={a.onClick}
            className={cx(
              'group flex min-h-24 flex-col justify-center gap-1 px-1 py-5 text-left transition-colors hover:bg-paper-2 sm:px-6',
              i > 0 && 'border-t border-ink/15 sm:border-t-0',
              i % 2 === 1 && 'sm:border-l sm:border-ink/15',
              i >= 2 && 'sm:border-t xl:border-t-0',
              i > 0 && 'xl:border-l xl:border-ink/15',
            )}
          >
            <span className="flex items-center justify-between gap-3 font-display text-[1.5rem] leading-tight">
              {a.label}
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full border border-ink/20 transition-colors group-hover:border-ink group-hover:bg-lime">
                <Plus className="size-4" />
              </span>
            </span>
            <span className="text-sm text-ink-3">{a.note}</span>
          </button>
        ))}
      </section>

      {empty ? (
        <section className="mt-10">
          <Notice
            title="Your workspace is empty"
            action={
              <>
                <Button onClick={() => setTxDialog({ ...emptyEntry(cur, ws.today), type: 'income', category: 'Opening balance', description: 'Opening balance' })}>Add an opening balance</Button>
                <Button variant="outline" onClick={() => navigate('/savings')}>
                  Set a tuition goal
                </Button>
                <Button variant="outline" onClick={() => setSampleOpen(true)}>
                  Load fictional sample data
                </Button>
              </>
            }
          >
            Start with what you hold today, set your tuition goal, and add your monthly support in Settings. Or explore with clearly labelled sample data first.
          </Notice>
        </section>
      ) : null}

      <section aria-labelledby="ov-atlas" className="on-dark mt-14 -mx-4 bg-ink px-4 py-10 text-paper sm:-mx-8 sm:px-8 lg:py-14">
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 id="ov-atlas" className="text-[2.25rem] leading-none text-paper">
              Money Atlas
            </h2>
            {supportBest ? (
              <p className="mt-4 text-[1.0625rem] text-paper/80">
                Your {formatMoney(ws.profile.monthlySupport, ws.profile.homeCurrency)} of monthly support would arrive as about{' '}
                <span className="font-semibold text-lime">{formatMoney(supportBest.receiveAmount, cur)}</span> through {supportBest.routeName}, the best simulated route.
              </p>
            ) : (
              <p className="mt-4 text-paper/80">Set your monthly support and currencies in Settings to see how it travels.</p>
            )}
            <p className="mt-3 text-sm text-mist">
              {c.corridors.length ? `${c.corridors.reduce((a, x) => a + x.count, 0)} simulated transfers recorded across ${c.corridors.length} corridor(s).` : 'No simulated transfers yet.'} Rates are illustrative.
            </p>
            <Link to="/atlas" className="mt-5 inline-flex min-h-11 items-center rounded-[var(--radius-ctl)] bg-lime px-4 text-sm font-medium text-ink hover:bg-lime-2">
              Open the Money Atlas
            </Link>
          </div>
          <div className="lg:col-span-8">
            <AtlasFrame origin={ws.profile.homeCurrency}>
              <AtlasMap origin={ws.profile.homeCurrency} selected={cur} corridors={c.corridors} variant="ambient" />
            </AtlasFrame>
          </div>
        </div>
      </section>

      <div className="mt-14 grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12">
        <section aria-labelledby="ov-spend" className="min-w-0 lg:col-span-7">
          <SectionHead id="ov-spend" title={`Spending in ${formatMonth(c.month)}`} action={<Link to="/budget" className="text-sm font-medium text-forest underline-offset-4 hover:underline">Budgets</Link>} />
          <div className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <p className="numeral text-[3.25rem]">{formatMoney(c.spending.spent, '')}</p>
            <p className="max-w-[34ch] text-sm text-ink-2">
              {c.spending.limit ? `${formatPercent(c.spending.utilization)} of your ${formatMoney(c.spending.limit, cur)} budget. ` : ''}
              {c.spendingPrevToDate.spent > 0
                ? `${diff >= 0 ? `${formatMoney(diff, cur)} more` : `${formatMoney(-diff, cur)} less`} than by day ${day} last month.`
                : 'Nothing recorded last month to compare with.'}
            </p>
          </div>
          <CategoryBars spending={c.spending} previous={c.spendingPrevToDate} currency={cur} />
        </section>

        <section aria-labelledby="ov-recent" className="min-w-0 lg:col-span-5">
          <SectionHead id="ov-recent" title="Recent activity" action={<Link to="/budget" className="text-sm font-medium text-forest underline-offset-4 hover:underline">All transactions</Link>} />
          {ws.transactions.length ? (
            <ul className="divide-y divide-ink/10">
              {ws.transactions.slice(0, 7).map((t) => (
                <LedgerRow key={t.id} t={t} />
              ))}
            </ul>
          ) : (
            <Empty title="No activity yet">Transactions you add appear here.</Empty>
          )}
        </section>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12">
        <section aria-labelledby="ov-path" className="min-w-0 lg:col-span-7">
          <SectionHead id="ov-path" title="Path to tuition" note={s ? `${s.monthsLeft} full month(s) to ${formatDate(s.deadline)}` : null} />
          {s ? <TuitionPath plan={s} today={ws.today} /> : <Empty title="No goal yet">Set a tuition goal to see your path.</Empty>}
        </section>
        <section aria-labelledby="ov-upcoming" className="min-w-0 lg:col-span-5">
          <SectionHead id="ov-upcoming" title="Coming up" note={`End-of-month estimate ${formatMoney(f.estimate, cur)}`} />
          {c.upcoming.length ? (
            <ul className="divide-y divide-ink/10">
              {c.upcoming.slice(0, 6).map((o) => (
                <li key={`${o.id}-${o.dueOn}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 py-3">
                  <span className="font-mono text-xs text-ink-3">{o.daysAway === 0 ? 'today' : `in ${o.daysAway}d`}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[0.9375rem]">{o.name}</span>
                    <span className="text-xs text-ink-3">
                      {formatDate(o.dueOn)}, {o.kind.toLowerCase()}
                    </span>
                  </span>
                  <span className="tabular text-[0.9375rem]">{formatMoney(o.amount, o.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing due">Add rent, insurance or fees in Budgets.</Empty>
          )}
        </section>
      </div>

      <TransactionDialog initial={txDialog} onClose={() => setTxDialog(null)} />
      <ContributionDialog open={contrib} onClose={() => setContrib(false)} sandbox={sandbox} />
      {sandbox.dialog}
      <ConfirmDialog open={sampleOpen} title="Load fictional sample data?" confirmLabel="Load sample data" busy={busy} onConfirm={loadSample} onCancel={() => setSampleOpen(false)}>
        This replaces the records in your workspace with three months of fictional data for an Azerbaijani student in Germany. The change is recorded in your activity.
      </ConfirmDialog>
    </>
  );
}

// ===========================================================================
// Money Atlas page
// ===========================================================================

function AtlasPage() {
  const { ws } = useWorkspace();
  const navigate = useNavigate();
  const p = ws.profile;
  const homeOk = placeFor(p.homeCurrency) ? p.homeCurrency : 'AZN';
  const [origin, setOrigin] = useState(homeOk);
  const [amountText, setAmountText] = useState(String(p.monthlySupport || 500));
  const [selected, setSelected] = useState(placeFor(p.studyCurrency) && p.studyCurrency !== homeOk ? p.studyCurrency : 'EUR');
  const sandbox = useSandboxAction();
  const amount = Number(amountText.trim().replace(',', '.'));
  const valid = /^\d+([.,]\d{1,2})?$/.test(amountText.trim()) && amount > 0 && amount <= 1_000_000;
  const dest = selected === origin ? ATLAS_PLACES.find((x) => x.currency !== origin).currency : selected;
  const rows = useMemo(
    () =>
      valid
        ? ATLAS_PLACES.filter((x) => x.currency !== origin).map((place) => {
            const cmp = compareTransfer({ amount, from: origin, to: place.currency });
            const eligible = cmp.quotes.filter((q) => q.eligible);
            return { place, cmp, best: cmp.quotes.find((q) => q.isBest), low: eligible.length ? Math.min(...eligible.map((q) => q.receiveAmount)) : null };
          })
        : [],
    [valid, amount, origin],
  );
  const current = rows.find((r) => r.place.currency === dest);
  const history = ws.computed.corridors.find((x) => x.from === origin && x.to === dest);
  const fromPlace = placeFor(origin);
  const toPlace = placeFor(dest);

  return (
    <>
      <PageIntro
        title="Money Atlas"
        lead={`Every corridor from ${fromPlace.city}, priced at illustrative rates through four simulated routes. Choose a destination on the map or in the table.`}
        aside={<SimTag>Illustrative rates, simulated routes</SimTag>}
      />
      <section aria-label="Money Atlas map" className="on-dark -mx-4 bg-forest text-paper sm:-mx-8">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 px-2 pt-6 pb-4 sm:px-6">
            <div className="flex flex-wrap items-end gap-4 px-2">
              <div className="w-40">
                <label htmlFor="atlas-amount" className="mb-1.5 block text-[0.8125rem] text-mist">
                  Amount in {origin}
                </label>
                <input
                  id="atlas-amount"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={!valid || undefined}
                  className="tabular min-h-11 w-full rounded-[var(--radius-ctl)] border border-paper/25 bg-forest-deep px-3 text-paper outline-none focus:border-lime"
                />
              </div>
              <div className="w-48">
                <label htmlFor="atlas-origin" className="mb-1.5 block text-[0.8125rem] text-mist">
                  Sending from
                </label>
                <select
                  id="atlas-origin"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  className="min-h-11 w-full rounded-[var(--radius-ctl)] border border-paper/25 bg-forest-deep px-3 text-paper outline-none focus:border-lime"
                >
                  {ATLAS_PLACES.map((x) => (
                    <option key={x.id} value={x.currency}>
                      {x.city}, {x.currency}
                    </option>
                  ))}
                </select>
              </div>
              {!valid ? <p className="pb-3 text-sm text-coral">Enter a plain amount, for example 500 or 500.50.</p> : null}
            </div>
            <AtlasFrame origin={origin} className="mt-4">
              <AtlasMap origin={origin} selected={dest} onSelect={setSelected} corridors={ws.computed.corridors} />
            </AtlasFrame>
            <p className="px-2 pt-1 text-xs text-mist md:hidden">Swipe the map sideways to see every destination.</p>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 px-2 pb-2 text-xs text-mist">
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-3 rounded-full border-2 border-lime" /> Sending from
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="h-[3px] w-6 bg-lime" /> Selected corridor
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="w-6 border-t border-dashed border-paper/50" /> Other corridors, illustrative
              </li>
              <li>Brighter dashes mark corridors you have simulated</li>
            </ul>
          </div>

          <aside aria-live="polite" aria-label="Selected corridor" className="border-t border-paper/15 px-6 py-8 xl:border-t-0 xl:border-l">
            {current ? (
              <>
                <p className="text-sm text-mist">
                  {fromPlace.city} to {toPlace.city}, {toPlace.country}
                </p>
                <p className="numeral mt-3 text-[3.25rem] text-lime">{current.best ? formatMoney(current.best.receiveAmount, '') : '—'}</p>
                <p className="mt-1 text-sm text-paper/80">
                  {dest} arrives for {formatMoney(amount, origin)} through {current.best?.routeName ?? 'no eligible route'}.
                </p>
                <Rows
                  dark
                  className="mt-6"
                  rows={[
                    ['Illustrative mid rate', formatRate(current.cmp.midRate, origin, dest), { mono: true }],
                    ['Best route fee', current.best ? formatMoney(current.best.fee, origin) : '—'],
                    ['Delivery', current.best?.deliveryLabel ?? '—'],
                    ['Range across routes', current.low != null && current.best ? `${formatMoney(current.low, '')} to ${formatMoney(current.best.receiveAmount, dest)}` : '—'],
                    ['Your simulations here', history ? `${history.count}, ${formatMoney(history.sent, origin)} sent` : 'None yet'],
                  ]}
                />
                <div className="mt-6 flex flex-col gap-2">
                  <Button variant="lime" disabled={!current.best} onClick={() => sandbox.propose('simulate_transfer', { routeId: current.best.routeId, amount, from: origin, to: dest })}>
                    Simulate with {current.best?.routeName ?? 'best route'}
                  </Button>
                  <Button variant="outlineDark" onClick={() => navigate(`/transfers?from=${origin}&to=${dest}&amount=${amount}`)}>
                    Compare all four routes
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-mist">Enter an amount to price the corridors.</p>
            )}
          </aside>
        </div>
      </section>

      <section aria-labelledby="atlas-table" className="mt-12">
        <SectionHead id="atlas-table" title={`All corridors from ${fromPlace.city}`} note={RATE_SOURCE_LABEL} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-ink/15 text-left text-ink-3">
                <th scope="col" className="py-2 pr-4 font-medium">Destination</th>
                <th scope="col" className="py-2 pr-4 font-medium">Illustrative rate</th>
                <th scope="col" className="py-2 pr-4 font-medium">Best simulated route</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Arrives</th>
                <th scope="col" className="py-2 text-right font-medium">Simulated so far</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {rows.map((r) => {
                const h = ws.computed.corridors.find((x) => x.from === origin && x.to === r.place.currency);
                const active = r.place.currency === dest;
                return (
                  <tr key={r.place.id} className={cx(active && 'bg-lime/40')}>
                    <td className="py-3 pr-4">
                      <button type="button" onClick={() => setSelected(r.place.currency)} aria-pressed={active} className="text-left font-medium underline-offset-4 hover:underline">
                        {r.place.city}, {r.place.country}
                      </button>
                    </td>
                    <td className="py-3 pr-4 font-mono text-[0.8125rem]">{formatRate(r.cmp.midRate, origin, r.place.currency)}</td>
                    <td className="py-3 pr-4">{r.best ? `${r.best.routeName}, fee ${formatMoney(r.best.fee, origin)}` : 'No eligible route'}</td>
                    <td className="tabular py-3 pr-4 text-right font-medium">{r.best ? formatMoney(r.best.receiveAmount, r.place.currency) : '—'}</td>
                    <td className="tabular py-3 text-right text-ink-3">{h ? `${h.count} (${formatMoney(h.received, r.place.currency)})` : '0'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {sandbox.dialog}
    </>
  );
}

// ===========================================================================
// Transfers
// ===========================================================================

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function TransfersPage() {
  const { ws } = useWorkspace();
  const [params] = useSearchParams();
  const p = ws.profile;
  const [form, setForm] = useState(() => ({
    amount: params.get('amount') ?? '500',
    from: params.get('from') ?? p.homeCurrency,
    to: params.get('to') ?? (p.studyCurrency === p.homeCurrency ? 'EUR' : p.studyCurrency),
    priority: 'max_received',
  }));
  const [result, setResult] = useState({ status: 'idle', data: null, error: null });
  const [chosen, setChosen] = useState(null);
  const sandbox = useSandboxAction();
  const query = useDebounced(form, 280);

  useEffect(() => {
    let alive = true;
    if (!query.amount.trim()) return undefined;
    const t = window.setTimeout(() => alive && setResult((r) => ({ ...r, status: 'loading' })), 0);
    api('/transfers/quote', { method: 'POST', body: query })
      .then((data) => alive && setResult({ status: 'ready', data, error: null }))
      .catch((e) => alive && setResult({ status: 'error', data: null, error: e.message }));
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const data = form.amount.trim() ? result.data : null;
  const best = data?.quotes.find((q) => q.isBest);
  const selected = data?.quotes.find((q) => q.routeId === chosen && q.eligible) ?? best;
  const eligible = data?.quotes.filter((q) => q.eligible) ?? [];
  const lo = eligible.length ? Math.min(...eligible.map((q) => q.receiveAmount)) : 0;
  const hi = eligible.length ? Math.max(...eligible.map((q) => q.receiveAmount)) : 1;
  const floor = lo - Math.max((hi - lo) * 1.2, hi * 0.01);
  const wallet = ws.computed.balances.find((b) => b.currency === form.from)?.amount ?? 0;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const sentence = 'min-h-14 rounded-[var(--radius-ctl)] border-b-2 border-ink bg-transparent px-1 font-display text-[2rem] leading-none outline-none focus:border-forest focus:bg-paper-3 sm:text-[2.75rem]';

  return (
    <>
      <PageIntro
        title="Transfers"
        lead="See exactly how fees and rate margins change what arrives, then simulate the route you would choose. Nothing is sent."
        aside={<SimTag>Simulated routes, illustrative rates</SimTag>}
      />

      <section aria-label="Transfer details" className="border-y border-ink/15 py-8">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
          <span className="font-display text-[2rem] leading-none sm:text-[2.75rem]">Send</span>
          <label className="sr-only" htmlFor="tf-amount">
            Amount to send
          </label>
          <input id="tf-amount" inputMode="decimal" autoComplete="off" value={form.amount} onChange={set('amount')} className={cx(sentence, 'tabular w-[6.5ch]')} />
          <label className="sr-only" htmlFor="tf-from">
            From currency
          </label>
          <select id="tf-from" value={form.from} onChange={set('from')} className={cx(sentence, 'pr-2')}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
          <span className="font-display text-[2rem] leading-none text-ink-3 sm:text-[2.75rem]">to</span>
          <label className="sr-only" htmlFor="tf-to">
            To currency
          </label>
          <select id="tf-to" value={form.to} onChange={set('to')} className={cx(sentence, 'pr-2')}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-3">Rank by</span>
            <Tabs label="Priority" value={form.priority} onChange={(v) => setForm((f) => ({ ...f, priority: v }))} options={Object.entries(PRIORITIES).map(([value, label]) => ({ value, label }))} />
          </div>
          <p className="text-sm text-ink-3">
            Simulated {form.from} wallet: <span className="tabular text-ink">{formatMoney(wallet, form.from)}</span>
          </p>
        </div>
      </section>

      <div aria-busy={result.status === 'loading'} className="mt-10">
        {!form.amount.trim() ? (
          <Empty title="Enter an amount to compare">The four simulated routes appear here, ranked.</Empty>
        ) : result.status === 'error' ? (
          <Notice tone="danger" title="Cannot compare this transfer">
            {result.error}
          </Notice>
        ) : !data ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <div className={cx('grid grid-cols-1 gap-x-12 gap-y-10 transition-opacity xl:grid-cols-12', result.status === 'loading' && 'opacity-60')}>
            <section aria-labelledby="tf-ladder" className="min-w-0 xl:col-span-7">
              <h2 id="tf-ladder" className="sr-only">
                Routes ranked
              </h2>
              <p aria-live="polite" className="mb-6 text-[1.0625rem] text-ink-2">
                {best ? (
                  <>
                    Best for {PRIORITIES[data.priority].toLowerCase()}: <span className="font-semibold text-ink">{best.routeName}</span>, about{' '}
                    <span className="mark font-semibold text-ink">{formatMoney(best.receiveAmount, data.to)}</span> in {best.deliveryLabel}.
                  </>
                ) : (
                  'No route accepts this amount. Each route has a minimum and maximum.'
                )}
              </p>
              <div role="radiogroup" aria-label="Choose a route" className="divide-y divide-ink/12 border-y border-ink/12">
                {data.quotes.map((q) => {
                  const active = selected?.routeId === q.routeId;
                  return (
                    <div
                      key={q.routeId}
                      role="radio"
                      aria-checked={active}
                      aria-disabled={!q.eligible}
                      aria-label={`${q.routeName}: ${q.eligible ? `${formatMoney(q.receiveAmount, data.to)} arrives` : q.ineligibleReason}`}
                      tabIndex={q.eligible ? 0 : -1}
                      onClick={() => q.eligible && setChosen(q.routeId)}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && q.eligible) {
                          e.preventDefault();
                          setChosen(q.routeId);
                        }
                      }}
                      className={cx(
                        'grid cursor-pointer grid-cols-1 gap-3 px-2 py-5 outline-none transition-colors sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-center sm:gap-6',
                        active ? 'bg-paper-2' : 'hover:bg-paper-2/60',
                        !q.eligible && 'cursor-not-allowed opacity-60',
                        'focus-visible:bg-paper-2 focus-visible:ring-2 focus-visible:ring-forest',
                      )}
                    >
                      <div>
                        <p className="flex items-center gap-2 font-medium">
                          <span aria-hidden="true" className={cx('size-4 rounded-full border-2', active ? 'border-ink bg-lime' : 'border-ink/30')} />
                          {q.routeName}
                        </p>
                        <p className="mt-0.5 pl-6 text-xs text-ink-3">{q.kind}</p>
                      </div>
                      <div className="relative h-8">
                        {q.eligible ? (
                          <>
                            <span className={cx('grow-x absolute inset-y-1 left-0 rounded-r-[4px]', q.isBest ? 'bg-lime' : 'bg-ink/15')} style={{ width: `${Math.max(8, ((q.receiveAmount - floor) / (hi - floor)) * 100)}%` }} />
                            <span className="absolute inset-y-0 left-2 flex items-center font-mono text-[0.6875rem] text-ink">{q.deliveryLabel}</span>
                          </>
                        ) : (
                          <span className="sim-dash absolute inset-y-1 left-0 w-full truncate rounded border border-ink/30 px-2 text-xs leading-6 text-ink-3">{q.ineligibleReason}</span>
                        )}
                      </div>
                      <div className="text-left sm:min-w-[9rem] sm:text-right">
                        <p className="numeral text-[2rem]">{q.eligible ? formatMoney(q.receiveAmount, '') : '—'}</p>
                        <p className="font-mono text-[0.6875rem] text-ink-3">
                          {q.eligible ? (q.lessThanBest > 0 ? `${formatMoney(q.lessThanBest, '')} less than best` : `${data.to}, best match`) : 'not available'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-ink-3">Bars share a baseline just below the lowest result so differences between routes are visible. {RATE_SOURCE_LABEL}.</p>
            </section>

            {selected ? (
              <aside aria-labelledby="tf-breakdown" className="min-w-0 xl:col-span-5">
                <div className="on-dark rounded-[var(--radius-panel)] bg-ink p-6 text-paper sm:p-8 xl:sticky xl:top-24">
                  <h2 id="tf-breakdown" className="text-[1.5rem] text-paper">
                    {selected.routeName}
                  </h2>
                  <p className="text-sm text-mist">{selected.goodFor}</p>
                  <ol className="mt-6 space-y-2.5 font-mono text-[0.8125rem]">
                    {[
                      ['You send', formatMoney(selected.sendAmount, data.from)],
                      ['− Route fee', formatMoney(selected.fee, data.from)],
                      ['= Converted', formatMoney(selected.convertedAmount, data.from)],
                      ['× Illustrative mid rate', selected.midRate.toFixed(4)],
                      [`× (1 − ${formatPercent(selected.marginPct, 1)} margin)`, selected.rate.toFixed(4)],
                    ].map(([k, v]) => (
                      <li key={k} className="flex justify-between gap-4 border-b border-paper/10 pb-2.5">
                        <span className="text-mist">{k}</span>
                        <span>{v}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-5 text-sm text-mist">Arrives, estimated</p>
                  <p className="numeral text-[3.5rem] text-lime">{formatMoney(selected.receiveAmount, '')}</p>
                  <p className="font-mono text-xs text-mist">
                    {data.to} in {selected.deliveryLabel}. Fees and margin cost {formatMoney(selected.totalCost, data.to)} ({formatPercent(selected.totalCostPct, 1)}).
                  </p>
                  <Button variant="lime" size="lg" className="mt-6 w-full" onClick={() => sandbox.propose('simulate_transfer', { routeId: selected.routeId, amount: form.amount, from: data.from, to: data.to })}>
                    Simulate this transfer
                  </Button>
                  <p className="mt-3 text-xs text-mist">You will confirm before anything is recorded. No money moves.</p>
                </div>
              </aside>
            ) : null}
          </div>
        )}
      </div>

      <section aria-labelledby="tf-history" className="mt-16">
        <SectionHead id="tf-history" title="Simulated transfers" note="Stored in your account. None of these were sent." />
        {ws.simulations.length ? (
          <ul className="divide-y divide-ink/10">
            {ws.simulations.slice(0, 12).map((s) => (
              <li key={s.id} className="grid grid-cols-1 gap-2 py-3.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center sm:gap-6">
                <span className="font-mono text-[0.8125rem]">{s.id}</span>
                <span className="text-sm text-ink-2">
                  {s.routeName}, fee {formatMoney(s.fee, s.sendCurrency)}, <span className="font-mono text-xs">{dateTime(s.createdAt)}</span>
                  {s.initiatedBy === 'assistant' ? ', via Bridge Intelligence' : ''} <SimTag className="ml-1">Simulated, not sent</SimTag>
                </span>
                <span className="tabular text-sm whitespace-nowrap">
                  {formatMoney(s.sendAmount, s.sendCurrency)} <span className="text-ink-3">to</span> <span className="font-semibold">{formatMoney(s.receiveAmount, s.receiveCurrency)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No simulated transfers yet">Choose a route above and confirm to record one.</Empty>
        )}
      </section>
      {sandbox.dialog}
    </>
  );
}

// ===========================================================================
// Budgets
// ===========================================================================

function BudgetLimits() {
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const sp = ws.computed.spending;
  const cur = ws.computed.currency;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const start = () => {
    setDraft(Object.fromEntries(sp.rows.map((r) => [r.category, r.limit ? String(r.limit) : ''])));
    setFields({});
    setEditing(true);
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await mutate(() => api('/budgets', { method: 'PUT', body: { limits: draft } }));
      notify('Budget limits saved.');
      setEditing(false);
    } catch (err) {
      setFields(err.fields ?? {});
      if (!err.fields) notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const total = round2(Object.values(draft).reduce((a, v) => a + (Number(v) || 0), 0));
  return (
    <section aria-labelledby="bd-limits" className="min-w-0">
      <SectionHead id="bd-limits" title="By category" action={editing ? null : <Button size="sm" variant="outline" icon={Pencil} onClick={start}>Edit limits</Button>} />
      {editing ? (
        <form onSubmit={save} noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {sp.rows.map((r) => (
              <MoneyField key={r.category} label={`${r.category} (${cur})`} value={draft[r.category] ?? ''} placeholder="No limit" onChange={(e) => setDraft((d) => ({ ...d, [r.category]: e.target.value }))} error={fields[r.category]} />
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button type="submit" busy={busy}>
              Save limits
            </Button>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="tabular ml-auto text-sm text-ink-2">Total {formatMoney(total, cur)} a month</span>
          </div>
        </form>
      ) : (
        <CategoryBars spending={sp} previous={ws.computed.spendingPrevToDate} currency={cur} />
      )}
    </section>
  );
}

function Transactions({ onAdd, onEdit }) {
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const [filters, setFilters] = useState({ q: '', type: 'all', category: 'all', currency: 'all', month: 'all' });
  const [limit, setLimit] = useState(25);
  const [toDelete, setToDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const months = useMemo(() => [...new Set(ws.transactions.map((t) => monthKey(t.occurredOn)))], [ws.transactions]);
  const set = (k) => (e) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setLimit(25);
  };
  const list = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return ws.transactions.filter((t) => {
      if (filters.type === 'expense' && t.type !== 'expense') return false;
      if (filters.type === 'income' && !['income', 'opening_balance'].includes(t.type)) return false;
      if (filters.type === 'transfer' && !t.type.startsWith('transfer')) return false;
      if (filters.type === 'savings' && t.type !== 'savings_contribution') return false;
      if (filters.category !== 'all' && t.category !== filters.category) return false;
      if (filters.currency !== 'all' && t.currency !== filters.currency) return false;
      if (filters.month !== 'all' && monthKey(t.occurredOn) !== filters.month) return false;
      if (q && !`${t.description} ${t.category ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [ws.transactions, filters]);
  const filtered = Object.entries(filters).some(([k, v]) => (k === 'q' ? v.trim() : v !== 'all'));
  const editable = (t) => !t.simulated && ['expense', 'income', 'opening_balance'].includes(t.type);
  const remove = async () => {
    setBusy(true);
    try {
      await mutate(() => api(`/transactions/${toDelete.id}`, { method: 'DELETE' }));
      notify('Transaction deleted.');
      setToDelete(null);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const selectCls = cx(INPUT, 'border-ink/20');
  return (
    <section aria-labelledby="bd-tx" className="min-w-0">
      <SectionHead id="bd-tx" title="Transactions" note={`${list.length} of ${ws.transactions.length}`} action={<Button size="sm" icon={Plus} onClick={onAdd}>Add</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-5">
        <label className="relative col-span-2 xl:col-span-1">
          <span className="sr-only">Search transactions</span>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input value={filters.q} onChange={set('q')} placeholder="Search" className={cx(selectCls, 'pl-9')} />
        </label>
        {[
          ['type', 'Type', [['all', 'All types'], ['expense', 'Expenses'], ['income', 'Income'], ['transfer', 'Simulated transfers'], ['savings', 'Savings']]],
          ['category', 'Category', [['all', 'All categories'], ...[...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((x) => [x, x])]],
          ['currency', 'Currency', [['all', 'All currencies'], ...CURRENCIES.map((x) => [x.code, x.code])]],
          ['month', 'Month', [['all', 'All months'], ...months.map((m) => [m, formatMonth(m)])]],
        ].map(([k, label, opts]) => (
          <label key={k}>
            <span className="sr-only">{label}</span>
            <select value={filters[k]} onChange={set(k)} className={selectCls}>
              {opts.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty
          title={filtered ? 'No transactions match' : 'No transactions yet'}
          action={
            filtered ? (
              <Button size="sm" variant="outline" onClick={() => setFilters({ q: '', type: 'all', category: 'all', currency: 'all', month: 'all' })}>
                Clear filters
              </Button>
            ) : (
              <Button size="sm" icon={Plus} onClick={onAdd}>
                Add your first transaction
              </Button>
            )
          }
        >
          {filtered ? 'Try a different filter.' : 'Record income and expenses to build your budget.'}
        </Empty>
      ) : (
        <>
          <ul className="divide-y divide-ink/10 border-t border-ink/10">
            {list.slice(0, limit).map((t) => (
              <LedgerRow
                key={t.id}
                t={t}
                actions={
                  editable(t) ? (
                    <span className="flex">
                      <button type="button" aria-label={`Edit ${t.description}`} onClick={() => onEdit(t)} className="rounded-[var(--radius-ctl)] p-2 text-ink-3 hover:bg-paper-2 hover:text-ink">
                        <Pencil aria-hidden="true" className="size-4" />
                      </button>
                      <button type="button" aria-label={`Delete ${t.description}`} onClick={() => setToDelete(t)} className="rounded-[var(--radius-ctl)] p-2 text-ink-3 hover:bg-coral/10 hover:text-coral-ink">
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </span>
                  ) : (
                    <span className="hidden w-[4.5rem] text-right text-xs text-ink-3 sm:inline">locked</span>
                  )
                }
              />
            ))}
          </ul>
          {list.length > limit ? (
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 25)}>
                Show {Math.min(25, list.length - limit)} more
              </Button>
            </div>
          ) : null}
        </>
      )}
      <p className="mt-4 text-xs text-ink-3">Simulated transfers and savings contributions are locked because they are part of your audit trail.</p>
      <ConfirmDialog open={Boolean(toDelete)} title="Delete this transaction?" confirmLabel="Delete" danger busy={busy} onConfirm={remove} onCancel={() => setToDelete(null)}>
        {toDelete ? (
          <>
            “{toDelete.description}”, {formatMoney(toDelete.amount, toDelete.currency)} on {formatDate(toDelete.occurredOn)}, will be removed. The deletion is recorded in your activity.
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function Bills() {
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const cur = ws.profile.studyCurrency;
  const blank = { name: '', category: 'Housing', amount: '', currency: cur, dueOn: ws.today, recurring: 'monthly' };
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blank);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(null);
  const [toPay, setToPay] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = async (e) => {
    e.preventDefault();
    setBusy('add');
    setFields({});
    try {
      await mutate(() => api('/obligations', { method: 'POST', body: form }));
      notify('Bill added.');
      setAdding(false);
      setForm(blank);
    } catch (err) {
      setFields(err.fields ?? {});
      if (!err.fields) notify(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const run = async (key, fn, msg) => {
    setBusy(key);
    try {
      await mutate(fn);
      notify(msg);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="bd-bills" className="min-w-0">
      <SectionHead id="bd-bills" title="Bills" action={adding ? null : <Button size="sm" variant="outline" icon={Plus} onClick={() => setAdding(true)}>Add bill</Button>} />
      {adding ? (
        <form onSubmit={add} noValidate className="mb-6 grid grid-cols-1 gap-3 rounded-[var(--radius-panel)] bg-paper-2 p-4 sm:grid-cols-2">
          <TextField label="Name" value={form.name} onChange={set('name')} error={fields.name} placeholder="Rent" maxLength={LIMITS.text} />
          <SelectField label="Category" value={form.category} onChange={set('category')} error={fields.category} options={EXPENSE_CATEGORIES} />
          <MoneyField label="Amount" value={form.amount} onChange={set('amount')} error={fields.amount} />
          <SelectField label="Currency" value={form.currency} onChange={set('currency')} error={fields.currency} options={CURRENCIES.map((x) => x.code)} />
          <TextField label="Next due date" type="date" value={form.dueOn} min={ws.today} onChange={set('dueOn')} error={fields.dueOn} />
          <SelectField label="Repeats" value={form.recurring} onChange={set('recurring')} error={fields.recurring} options={[{ value: 'monthly', label: 'Every month' }, { value: 'once', label: 'One-off' }]} />
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" busy={busy === 'add'}>
              Save bill
            </Button>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {ws.obligations.length ? (
        <ul className="divide-y divide-ink/10 border-t border-ink/10">
          {ws.obligations.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem]">{o.name}</p>
                <p className="text-xs text-ink-3">
                  Due {formatDate(o.dueOn)}, {o.recurring === 'monthly' ? 'monthly' : 'one-off'}
                </p>
              </div>
              <span className="tabular text-[0.9375rem]">{formatMoney(o.amount, o.currency)}</span>
              <span className="flex gap-1">
                <Button size="sm" variant="outline" busy={busy === `pay${o.id}`} onClick={() => setToPay(o)}>
                  Mark paid
                </Button>
                <button type="button" aria-label={`Delete ${o.name}`} onClick={() => run(`del${o.id}`, () => api(`/obligations/${o.id}`, { method: 'DELETE' }), 'Bill removed.')} className="rounded-[var(--radius-ctl)] p-2 text-ink-3 hover:bg-coral/10 hover:text-coral-ink">
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No bills yet">Add rent, insurance or semester fees to include them in your forecast.</Empty>
      )}
      <ConfirmDialog
        open={Boolean(toPay)}
        title="Record this bill as paid?"
        confirmLabel="Record payment"
        busy={typeof busy === 'string' && busy.startsWith('pay')}
        onCancel={() => setToPay(null)}
        onConfirm={async () => {
          const o = toPay;
          await run(`pay${o.id}`, () => api(`/obligations/${o.id}/pay`, { method: 'POST' }), `${o.name} recorded as an expense.`);
          setToPay(null);
        }}
      >
        {toPay ? (
          <>
            Adds an expense of {formatMoney(toPay.amount, toPay.currency)} to {toPay.category} dated today
            {toPay.recurring === 'monthly' ? ' and moves the next due date forward one month.' : ' and removes this one-off bill.'} This updates your records; no payment is made.
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function BudgetPage() {
  const { ws } = useWorkspace();
  const [dialog, setDialog] = useState(null);
  const sp = ws.computed.spending;
  const cur = ws.computed.currency;
  const add = () => setDialog(emptyEntry(cur, ws.today));
  const edit = (t) => setDialog({ ...t, type: t.type === 'opening_balance' ? 'income' : t.type, amount: String(t.amount) });
  const p = moneyParts(sp.spent, cur);
  return (
    <>
      <PageIntro title="Budgets" lead={`Income and expenses in any of six currencies, converted to ${cur} at illustrative rates for every total.`} aside={<Button icon={Plus} onClick={add}>Add transaction</Button>} />
      <section aria-label="This month" className="grid grid-cols-1 items-end gap-x-12 gap-y-6 border-y border-ink/15 py-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <p className="text-sm text-ink-3">Spent in {formatMonth(ws.computed.month)}</p>
          <p className="numeral mt-2 text-[4.5rem] sm:text-[6rem]">
            <span className="align-[0.4em] text-[0.6em]">{p.symbol}</span>
            {p.int}
            <span className="ml-[0.04em] align-[0.95em] text-[0.34em] tracking-normal text-ink-3">.{p.dec}</span>
          </p>
        </div>
        <Rows
          className="lg:col-span-5"
          rows={[
            ['Monthly budget', sp.limit ? formatMoney(sp.limit, cur) : 'Not set'],
            [sp.remaining >= 0 ? 'Left this month' : 'Over budget by', formatMoney(Math.abs(sp.remaining), cur), { strong: true, tone: sp.remaining < 0 ? 'coral' : undefined, mark: sp.remaining >= 0 && sp.limit > 0 }],
            ['Income recorded this month', formatMoney(ws.computed.incomeThisMonth, cur)],
            ['End-of-month estimate', formatMoney(ws.computed.forecast.estimate, cur)],
          ]}
        />
      </section>
      <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-14 xl:grid-cols-12">
        <div className="min-w-0 space-y-14 xl:col-span-7">
          <BudgetLimits />
          <Transactions onAdd={add} onEdit={edit} />
        </div>
        <div className="min-w-0 xl:col-span-5">
          <Bills />
          <p className="mt-10 text-sm text-ink-3">
            Currencies and monthly support live in{' '}
            <Link to="/settings" className="font-medium text-forest underline underline-offset-4">
              Settings
            </Link>
            .
          </p>
        </div>
      </div>
      <TransactionDialog initial={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

// ===========================================================================
// Tuition goals
// ===========================================================================

function GoalForm({ goal, onDone }) {
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const [form, setForm] = useState(
    goal
      ? { name: goal.name, target: String(goal.target), currency: goal.currency, deadline: goal.deadline, startingSaved: String(goal.startingSaved), plannedMonthly: String(goal.plannedMonthly) }
      : { name: 'Tuition', target: '', currency: ws.profile.studyCurrency, deadline: '', startingSaved: '0', plannedMonthly: '' },
  );
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await mutate(() => api('/savings-goal', { method: 'PUT', body: { ...form, plannedMonthly: form.plannedMonthly || '0', startingSaved: form.startingSaved || '0' } }));
      notify('Tuition goal saved.');
      onDone?.();
    } catch (err) {
      setFields(err.fields ?? {});
      if (!err.fields) notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField label="Goal name" value={form.name} onChange={set('name')} error={fields.name} maxLength={60} className="sm:col-span-2" />
      <MoneyField label="Tuition target" value={form.target} onChange={set('target')} error={fields.target} placeholder="4500" />
      <SelectField label="Currency" value={form.currency} onChange={set('currency')} error={fields.currency} options={CURRENCIES.map((x) => x.code)} />
      <TextField label="Payment deadline" type="date" value={form.deadline} min={ws.today} onChange={set('deadline')} error={fields.deadline} />
      <MoneyField label="Saved before CampusBridge" value={form.startingSaved} onChange={set('startingSaved')} error={fields.startingSaved} />
      <MoneyField label="You plan to save each month" value={form.plannedMonthly} onChange={set('plannedMonthly')} error={fields.plannedMonthly} hint="Used to project when you will finish." className="sm:col-span-2" />
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" busy={busy}>
          Save goal
        </Button>
        {goal && onDone ? (
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SavingsPage() {
  const { ws } = useWorkspace();
  const s = ws.computed.savings;
  const [editing, setEditing] = useState(false);
  const [contrib, setContrib] = useState(false);
  const sandbox = useSandboxAction();
  const contributions = ws.transactions.filter((t) => t.type === 'savings_contribution');

  if (!s || editing) {
    return (
      <>
        <PageIntro title={s ? 'Edit tuition goal' : 'Set your tuition goal'} lead="Target, deadline and what you have saved so far. Every figure is checked on the server." />
        <div className="max-w-3xl border-t border-ink/15 pt-8">
          <GoalForm goal={ws.goal} onDone={s ? () => setEditing(false) : undefined} />
        </div>
      </>
    );
  }

  const statusLine =
    s.status === 'funded'
      ? 'Fully funded. Your savings cover the target.'
      : s.status === 'on_track'
        ? `On track. At ${formatMoney(s.plannedMonthly, s.currency)} a month you finish around ${formatDate(s.projectedCompletion)}, before the deadline.`
        : s.status === 'behind'
          ? `Behind. You plan ${formatMoney(s.plannedMonthly, s.currency)} a month but need ${formatMoney(s.requiredMonthly, s.currency)}, so about ${formatMoney(s.shortfallAtDeadline, s.currency)} would be missing on ${formatDate(s.deadline)}.`
          : s.status === 'no_plan'
            ? `You need ${formatMoney(s.requiredMonthly, s.currency)} a month. Set a planned monthly saving to project a finish date.`
            : 'The deadline has passed. Update it to plan again.';

  return (
    <>
      <PageIntro title="Tuition goals" lead={`${s.name}, due ${formatDate(s.deadline)}.`} aside={<Button variant="outline" icon={Pencil} onClick={() => setEditing(true)}>Edit goal</Button>} />

      <section aria-label="Progress" className="on-dark -mx-4 bg-forest px-4 py-10 text-paper sm:-mx-8 sm:px-8 lg:py-14">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
          <div className="flex flex-wrap items-center gap-8 lg:col-span-7">
            <ProgressArc value={s.progress} size={220} stroke={12}>
              <span className="numeral text-[4.5rem] text-paper">
                {Math.round(s.progress * 100)}
                <span className="text-[0.45em]">%</span>
              </span>
            </ProgressArc>
            <div className="min-w-0">
              <p className="numeral text-[2.75rem] text-lime sm:text-[3.5rem]">{formatMoney(s.saved, '')}</p>
              <p className="mt-2 text-paper/80">
                saved of {formatMoney(s.target, s.currency)}. {formatMoney(s.remaining, s.currency)} to go in {Math.max(0, s.daysLeft)} days.
              </p>
            </div>
          </div>
          <div className="lg:col-span-5">
            <p className={cx('text-[1.0625rem]', s.status === 'behind' ? 'text-coral' : 'text-paper')}>{statusLine}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              {s.remaining > 0 ? (
                <Button variant="lime" icon={Plus} onClick={() => setContrib(true)}>
                  Add to savings
                </Button>
              ) : null}
              <Link to="/intelligence?task=tuition" className="inline-flex min-h-11 items-center rounded-[var(--radius-ctl)] border border-paper/30 px-4 text-sm font-medium hover:border-paper">
                Ask Bridge Intelligence
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-14 grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12">
        <section aria-labelledby="sv-path" className="min-w-0 lg:col-span-8">
          <SectionHead id="sv-path" title="Path to the target" note="Hover a month for the figures" />
          <TuitionPath plan={s} today={ws.today} height={280} />
          <details className="mt-8 border-t border-ink/15 pt-4 text-sm text-ink-2">
            <summary className="cursor-pointer font-medium text-ink">How this is calculated</summary>
            <ul className="mt-3 list-disc space-y-1.5 pl-5">
              <li>Saved = saved before CampusBridge + contributions recorded here.</li>
              <li>Needed each month = still to save ÷ full months until the deadline (at least one).</li>
              <li>Projected finish = today + still to save ÷ planned monthly saving, rounded up to whole months.</li>
              <li>Not included: tuition changes, transfer fees, exchange-rate moves. Keep a buffer.</li>
            </ul>
          </details>
        </section>
        <section aria-labelledby="sv-figures" className="min-w-0 lg:col-span-4">
          <SectionHead id="sv-figures" title="Figures" />
          <Rows
            rows={[
              ['Still to save', formatMoney(s.remaining, s.currency), { strong: true }],
              ['Needed each month', formatMoney(s.requiredMonthly, s.currency), { strong: true, mark: true }],
              ['You plan each month', formatMoney(s.plannedMonthly, s.currency)],
              ...(s.monthlyGap > 0 ? [['Monthly gap', formatMoney(s.monthlyGap, s.currency), { tone: 'coral', strong: true }]] : []),
              ['Projected finish', s.projectedCompletion ? formatDate(s.projectedCompletion) : '—', { tone: s.status === 'behind' ? 'coral' : undefined }],
              ['Saved before CampusBridge', formatMoney(s.startingSaved, s.currency)],
              ['Contributed here', formatMoney(s.contributed, s.currency)],
            ]}
          />
          <h3 className="mt-10 mb-3 text-[1.25rem]">Contributions</h3>
          {contributions.length ? (
            <ul className="divide-y divide-ink/10 border-t border-ink/10">
              {contributions.slice(0, 8).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="font-mono text-xs text-ink-3">
                    {t.occurredOn}
                    {t.createdBy === 'assistant' ? ' via assistant' : ''}
                  </span>
                  <span className="tabular font-medium">{formatMoney(t.amount, t.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No contributions yet">Contributions you confirm appear here.</Empty>
          )}
        </section>
      </div>
      <ContributionDialog open={contrib} onClose={() => setContrib(false)} sandbox={sandbox} />
      {sandbox.dialog}
    </>
  );
}

// ===========================================================================
// Bridge Intelligence
// ===========================================================================

const SUGGESTED = [
  'Find the lowest-fee simulated route for sending 500 AZN.',
  'Calculate how much I should save each month to meet my tuition deadline.',
  'Forecast my end-of-month balance.',
  'Explain why my spending increased this month.',
  'I spent 23.40 EUR on groceries',
  'How do I build credit as a student?',
];
const TASK_PRESETS = { tuition: SUGGESTED[1] };
const TRAIL = (e) => /\.(executed|confirmed|rejected|expired)$/.test(e.action) || e.action === 'assistant.refused';

/** Group the stored conversation into tasks: a request plus the replies that followed it. */
function toTasks(messages) {
  const outcomes = {};
  for (const m of messages) if (m.kind === 'outcome' && m.actionId) outcomes[m.actionId] = m;
  const tasks = [];
  for (const m of messages) {
    if (m.role === 'user') tasks.push({ id: m.id, request: m.text, at: m.createdAt, replies: [] });
    else if (m.kind !== 'outcome' && tasks.length) tasks.at(-1).replies.push(m);
  }
  return { tasks: tasks.reverse(), outcomes };
}

function ProposalBlock({ action, outcome, onDecide, onOpen }) {
  const [busy, setBusy] = useState(null);
  const p = action.preview;
  const status = action.status;
  const decide = async (ok) => {
    setBusy(ok ? 'yes' : 'no');
    await onDecide(action, ok);
    setBusy(null);
  };
  const label = { pending: 'Waiting for your confirmation', confirmed: 'Executed in the sandbox', rejected: 'Cancelled, nothing changed', expired: 'Expired, nothing changed', failed: 'Stopped on re-check' }[status];
  return (
    <div className={cx('sim-dash mt-5 rounded-[var(--radius-panel)] border p-4', status === 'pending' ? 'border-ink bg-paper-3' : 'border-ink/30')}>
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-ink-2">Proposed action</span>
        <span className={cx('rounded-full px-2 py-0.5 font-medium', status === 'confirmed' ? 'bg-lime text-ink' : status === 'failed' ? 'bg-coral/20 text-coral-ink' : 'bg-paper-2 text-ink-2')}>{label}</span>
      </p>
      <p className="mt-2 font-medium">{p?.title ?? action.label}</p>
      {p ? <Rows className="mt-2" rows={p.rows.map(([k, v]) => [k, v, k.startsWith('Estimated to arrive') ? { strong: true, mark: true } : {}])} /> : null}
      {status === 'pending' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {action.type === 'simulate_transfer' ? (
            <Button size="sm" icon={Check} onClick={() => onOpen(action)}>
              Review and confirm
            </Button>
          ) : (
            <Button size="sm" icon={Check} busy={busy === 'yes'} onClick={() => decide(true)}>
              Confirm
            </Button>
          )}
          <Button size="sm" variant="outline" busy={busy === 'no'} onClick={() => decide(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {status === 'confirmed' && outcome?.steps ? (
        <ol className="mt-4 space-y-1.5 border-t border-ink/10 pt-3 text-[0.8125rem]">
          {outcome.steps.map((s) => (
            <li key={s.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
              <span className="font-mono text-[0.75rem] text-forest">{s.label}</span>
              <span className="text-ink-2">{s.detail}</span>
            </li>
          ))}
        </ol>
      ) : action.result?.summary || action.result?.error ? (
        <p className={cx('mt-3 text-sm', action.result.error ? 'text-coral-ink' : 'text-forest')}>{action.result.summary ?? action.result.error}</p>
      ) : null}
      {p?.note ? <p className="mt-3 text-xs text-ink-3">{p.note}</p> : null}
    </div>
  );
}

function TaskRecord({ task, outcomes, onDecide, onOpen, onSimulateRoute, latest }) {
  return (
    <article className={cx('border-t pt-6', latest ? 'border-ink' : 'border-ink/15')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="max-w-[40ch] text-[1.5rem] leading-snug">{task.request}</h3>
        <time dateTime={task.at} className="font-mono text-xs text-ink-3">
          {clock(task.at)}
        </time>
      </div>
      {task.replies.map((r) => {
        const outcome = r.action ? outcomes[r.action.id] : null;
        return (
          <div key={r.id} className="mt-5 grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <p className={cx('text-[1.0625rem]', r.kind === 'refusal' ? 'text-coral-ink' : 'text-ink')}>
                <span className="font-semibold">{r.title}.</span> {r.summary}
              </p>
              {r.facts?.length ? <Rows className="mt-4" rows={r.facts.map(([k, v]) => [k, v])} /> : null}
              {r.table ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[30rem] text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-ink/15 text-left text-ink-3">
                        {r.table.columns.map((c) => (
                          <th key={c} scope="col" className="py-2 pr-3 font-medium">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink/10">
                      {r.table.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j} className={cx('tabular py-2 pr-3', j === 0 ? 'text-ink' : 'text-ink-2')}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {r.notices?.length ? (
                <ul className="mt-4 space-y-1 text-xs text-ink-3">
                  {r.notices.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="min-w-0 lg:col-span-5">
              {r.steps?.length ? (
                <ol className="space-y-2 text-[0.8125rem]">
                  {r.steps.map((s, i) => (
                    <li key={i} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                      <span className="font-mono text-[0.75rem] text-forest">{s.label}</span>
                      <span className="text-ink-2">{s.detail}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {r.action ? <ProposalBlock action={r.action} outcome={outcome} onDecide={onDecide} onOpen={onOpen} /> : null}
              {r.routes?.length > 1 && r.action?.status === 'pending' ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-3">
                  Other routes:
                  {r.routes
                    .filter((x) => !r.action.preview?.title.includes(x.routeName))
                    .map((x) => (
                      <button key={x.routeId} type="button" onClick={() => onSimulateRoute(r.transfer, x.routeId)} className="rounded-full border border-ink/20 px-3 py-1 text-ink-2 hover:border-ink hover:text-ink">
                        {x.routeName}, {x.receive}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </article>
  );
}

function IntelligencePage() {
  const { ws, reload } = useWorkspace();
  const { expire } = useAuth();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const [messages, setMessages] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState(() => TASK_PRESETS[params.get('task')] ?? '');
  const [sending, setSending] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [trail, setTrail] = useState([]);
  const inputRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([api('/assistant/messages'), api('/activity?limit=200')]);
      setMessages(m.messages);
      setTrail(a.events.filter(TRAIL));
      setLoadError(null);
    } catch (e) {
      if (e.status === 401) expire();
      else setLoadError(e.message);
    }
  }, [expire]);
  const sandbox = useSandboxAction(refresh);

  useEffect(() => {
    let alive = true;
    Promise.all([api('/assistant/messages'), api('/activity?limit=200')])
      .then(([m, a]) => {
        if (!alive) return;
        setMessages(m.messages);
        setTrail(a.events.filter(TRAIL));
      })
      .catch((e) => {
        if (!alive) return;
        if (e.status === 401) expire();
        else setLoadError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [expire]);

  useEffect(() => {
    if (params.get('task')) setParams({}, { replace: true });
  }, [params, setParams]);

  const send = async (text) => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(t);
    setDraft('');
    try {
      const d = await api('/assistant/messages', { method: 'POST', body: { text: t } });
      setMessages(d.messages);
      await reload();
      const a = await api('/activity?limit=200');
      setTrail(a.events.filter(TRAIL));
    } catch (e) {
      if (e.status === 401) expire();
      notify(e.message, 'error');
      setDraft(t);
    } finally {
      setSending(null);
    }
  };

  const decide = async (action, ok) => {
    try {
      const d = await api(`/actions/${action.id}/${ok ? 'confirm' : 'reject'}`, { method: 'POST' });
      notify(ok ? d.action.result.summary : 'Cancelled. Nothing was recorded.', ok ? 'success' : 'info');
    } catch (e) {
      notify(e.message, 'error');
    }
    await refresh();
    await reload();
  };

  const { tasks, outcomes } = useMemo(() => toTasks(messages ?? []), [messages]);
  const last = messages?.filter((m) => m.role === 'assistant' && m.kind !== 'outcome').at(-1);
  const c = ws.computed;
  const suggestions = last?.suggestions?.length ? [...new Set([...last.suggestions, ...SUGGESTED])].slice(0, 6) : SUGGESTED;

  return (
    <>
      <section aria-labelledby="bi-title" className="on-dark -mx-4 bg-ink px-4 pt-12 pb-10 text-paper sm:-mx-8 sm:px-8 sm:pt-16">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8">
            <h1 id="bi-title" data-page-title tabIndex={-1} className="text-[3rem] leading-none text-paper outline-none sm:text-[4.5rem]">
              Bridge Intelligence
            </h1>
            <p className="mt-4 max-w-[58ch] text-paper/75">
              Give it a task. It works out the figures from your own records, shows its working, and proposes an action that runs in the sandbox only after you confirm.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
              className="mt-8"
            >
              <label htmlFor="bi-input" className="sr-only">
                Your task
              </label>
              <div className="flex flex-col gap-3 border-b-2 border-paper/40 pb-3 focus-within:border-lime sm:flex-row sm:items-end">
                <textarea
                  id="bi-input"
                  ref={inputRef}
                  rows={2}
                  value={draft}
                  maxLength={800}
                  placeholder="Compare sending 500 AZN to my EUR budget"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send(draft);
                    }
                  }}
                  className="min-h-16 flex-1 resize-none bg-transparent font-display text-[1.5rem] leading-snug text-paper outline-none placeholder:text-paper/35 sm:text-[1.875rem]"
                />
                <Button type="submit" variant="lime" size="lg" disabled={!draft.trim()} busy={Boolean(sending)}>
                  Run task
                </Button>
              </div>
            </form>
            <div className="mt-6">
              <p className="text-sm text-mist">Suggested tasks</p>
              <ul className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {suggestions.map((q) => (
                  <li key={q} className="border-b border-paper/12">
                    <button type="button" onClick={() => send(q)} className="w-full py-2.5 text-left text-[0.9375rem] text-paper/85 transition-colors hover:text-lime">
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <aside aria-label="Your context" className="min-w-0 lg:col-span-4">
            <p className="text-sm text-mist">What it is working from</p>
            <Rows
              dark
              className="mt-2"
              rows={[
                ['Available now', formatMoney(c.totalAvailable, c.currency), { strong: true }],
                ['Budget left this month', c.spending.limit ? formatMoney(c.spending.remaining, c.currency) : 'No budget set'],
                ['Tuition', c.savings ? `${Math.round(c.savings.progress * 100)}%, ${SAVINGS_STATUS[c.savings.status].toLowerCase()}` : 'No goal'],
                ['End-of-month estimate', formatMoney(c.forecast.estimate, c.currency)],
              ]}
            />
            <p className="mt-6 text-xs text-mist">Rules-based. No AI model is connected, and it can only see your own account. Card numbers and passwords you type are removed before anything is stored.</p>
          </aside>
        </div>
      </section>

      <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-14 xl:grid-cols-12">
        <section aria-labelledby="bi-log" aria-live="polite" className="min-w-0 xl:col-span-8">
          <SectionHead
            id="bi-log"
            title="Task log"
            note={tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}, newest first` : null}
            action={tasks.length ? <Button size="sm" variant="outline" icon={Trash2} onClick={() => setConfirmClear(true)}>Clear log</Button> : null}
          />
          {sending ? (
            <article className="mb-8 border-t border-ink pt-6">
              <h3 className="text-[1.5rem]">{sending}</h3>
              <p role="status" className="mt-3 flex items-center gap-2 text-sm text-ink-3">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Working through the task
              </p>
            </article>
          ) : null}
          {loadError ? (
            <Notice tone="danger" title="The task log could not be loaded" action={<Button size="sm" variant="outline" onClick={refresh}>Try again</Button>}>
              {loadError}
            </Notice>
          ) : messages === null ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-40" />
            </div>
          ) : tasks.length === 0 && !sending ? (
            <Empty title="No tasks yet" action={<Button onClick={() => inputRef.current?.focus()}>Write a task</Button>}>
              Try comparing a transfer. You will see each step, then decide whether to record it.
            </Empty>
          ) : (
            <div className="space-y-10">
              {tasks.map((t, i) => (
                <TaskRecord
                  key={t.id}
                  task={t}
                  latest={i === 0}
                  outcomes={outcomes}
                  onDecide={decide}
                  onOpen={sandbox.open}
                  onSimulateRoute={(tr, routeId) => sandbox.propose('simulate_transfer', { ...tr, routeId })}
                />
              ))}
            </div>
          )}
        </section>
        <aside aria-labelledby="bi-trail" className="min-w-0 xl:col-span-4">
          <SectionHead id="bi-trail" title="Sandbox audit trail" />
          {trail.length ? (
            <ol className="divide-y divide-ink/10">
              {trail.slice(0, 12).map((e) => (
                <li key={e.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3 py-2.5 text-[0.8125rem]">
                  <time dateTime={e.ts} className="font-mono text-[0.75rem] text-ink-3">
                    {clock(e.ts)}
                  </time>
                  <span className="min-w-0">
                    <span className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
                    {eventDetail(e) ? <span className="block break-words text-ink-3">{eventDetail(e)}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="Nothing executed yet">Confirmed, cancelled and refused tasks are recorded here.</Empty>
          )}
          <Link to="/activity" className="mt-4 inline-block text-sm font-medium text-forest underline-offset-4 hover:underline">
            Full activity
          </Link>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear the task log?"
        confirmLabel="Clear log"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          try {
            await api('/assistant/messages', { method: 'DELETE' });
            await refresh();
            await reload();
            notify('Task log cleared. Open proposals were withdrawn.', 'info');
          } catch (e) {
            notify(e.message, 'error');
          }
          setConfirmClear(false);
        }}
      >
        Requests and replies are removed and open proposals are withdrawn. Your records and the activity log stay as they are.
      </ConfirmDialog>
      {sandbox.dialog}
    </>
  );
}

// ===========================================================================
// Activity
// ===========================================================================

const ACTION_LABELS = {
  'auth.registered': 'Account created',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'expense.created': 'Expense added',
  'expense.updated': 'Expense edited',
  'expense.deleted': 'Expense deleted',
  'income.created': 'Income added',
  'income.updated': 'Income edited',
  'income.deleted': 'Income deleted',
  'transaction.create': 'Transaction rejected',
  'budget.updated': 'Budget limits changed',
  'profile.updated': 'Currencies and support changed',
  'savings_goal.created': 'Tuition goal created',
  'savings_goal.updated': 'Tuition goal edited',
  'obligation.created': 'Bill added',
  'obligation.deleted': 'Bill removed',
  'obligation.paid': 'Bill recorded as paid',
  'simulate_transfer.proposed': 'Transfer simulation proposed',
  'simulate_transfer.confirmed': 'Transfer simulation confirmed',
  'simulate_transfer.rejected': 'Transfer simulation declined',
  'simulate_transfer.expired': 'Transfer simulation expired',
  'simulate_transfer.executed': 'Simulated transfer recorded',
  'savings_contribution.proposed': 'Savings contribution proposed',
  'savings_contribution.confirmed': 'Savings contribution confirmed',
  'savings_contribution.rejected': 'Savings contribution declined',
  'savings_contribution.expired': 'Savings contribution expired',
  'savings_contribution.executed': 'Savings contribution recorded',
  'add_expense.proposed': 'Expense proposed by Bridge Intelligence',
  'add_expense.confirmed': 'Proposed expense confirmed',
  'add_expense.rejected': 'Proposed expense declined',
  'add_expense.expired': 'Proposed expense expired',
  'add_expense.executed': 'Expense recorded',
  'assistant.answered': 'Bridge Intelligence answered',
  'assistant.refused': 'Bridge Intelligence refused a request',
  'assistant.cleared': 'Task log cleared',
  'workspace.sample_loaded': 'Sample data loaded',
  'workspace.cleared': 'Workspace cleared',
};

const ACTIVITY_FILTERS = [
  ['all', 'Everything', () => true],
  ['transfers', 'Transfers', (e) => e.action.startsWith('simulate_transfer')],
  ['money', 'Income and expenses', (e) => /^(expense|income|transaction|add_expense|obligation|budget)\./.test(e.action)],
  ['savings', 'Savings', (e) => /^savings_/.test(e.action)],
  ['assistant', 'Bridge Intelligence', (e) => e.actor === 'assistant' || e.action.startsWith('assistant')],
  ['account', 'Account', (e) => /^(auth|profile|workspace)\./.test(e.action)],
  ['issues', 'Rejected and failed', (e) => ['failed', 'validation_failed', 'rejected', 'expired'].includes(e.outcome)],
];

function eventDetail(e) {
  const d = e.detail ?? {};
  if (d.summary) return d.summary;
  if (d.reason) return d.reason;
  if (d.preview) return d.preview;
  if (d.reasons) return `Blocked: ${d.reasons.join(', ').replaceAll('_', ' ')}`;
  if (d.intent) return `Task: ${d.intent.replaceAll('_', ' ')}${d.actionId ? `, proposal ${d.actionId}` : ''}`;
  if (d.amount != null && d.currency) return `${formatMoney(d.amount, d.currency)}${d.category ? `, ${d.category}` : ''}${d.description ? `, ${d.description}` : ''}`;
  if (d.from && d.to) return `${formatMoney(d.from.amount, d.from.currency)} to ${formatMoney(d.to.amount, d.to.currency)}`;
  if (d.fields) return `Invalid fields: ${d.fields.join(', ')}`;
  if (d.note) return d.note;
  return null;
}

function ActivityPage() {
  const { ws } = useWorkspace();
  const { expire } = useAuth();
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const sig = `${ws.transactions.length}:${ws.simulations.length}:${ws.pendingActions.length}`;
  useEffect(() => {
    let alive = true;
    api('/activity?limit=300')
      .then((d) => {
        if (!alive) return;
        setEvents(d.events);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        if (e.status === 401) expire();
        else setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [sig, expire]);
  const test = ACTIVITY_FILTERS.find(([k]) => k === filter)[2];
  const list = events?.filter(test) ?? [];
  const groups = [];
  for (const e of list) {
    const day = e.ts.slice(0, 10);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(e);
  }
  const outcomeStyle = (o) =>
    ({ success: 'bg-lime text-ink', confirmed: 'bg-lime text-ink', pending: 'sim-dash border border-ink/40 text-ink-2', failed: 'bg-coral/20 text-coral-ink', validation_failed: 'bg-coral/20 text-coral-ink' })[o] ?? 'bg-paper-2 text-ink-2';
  return (
    <>
      <PageIntro title="Activity" lead="Every change, proposal, confirmation and refusal on your account, newest first. Passwords, session tokens and message text are never recorded." />
      <div className="mb-8 border-y border-ink/15 py-3">
        <Tabs label="Filter activity" value={filter} onChange={setFilter} options={ACTIVITY_FILTERS.map(([value, label]) => ({ value, label }))} />
      </div>
      {error ? (
        <Notice tone="danger" title="Activity could not be loaded">
          {error}
        </Notice>
      ) : events === null ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Empty title="Nothing here yet">Matching events appear as you use CampusBridge.</Empty>
      ) : (
        <div className="space-y-12">
          {groups.map((g) => (
            <section key={g.day} aria-label={formatDate(g.day)} className="grid grid-cols-1 gap-x-12 gap-y-3 lg:grid-cols-12">
              <h2 className="text-[1.75rem] leading-none lg:col-span-3">{formatDate(g.day)}</h2>
              <ol className="divide-y divide-ink/10 border-t border-ink/15 lg:col-span-9">
                {g.items.map((e) => {
                  const detail = eventDetail(e);
                  return (
                    <li key={e.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 py-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                      <time dateTime={e.ts} className="pt-0.5 font-mono text-xs text-ink-3">
                        {clock(e.ts)}
                      </time>
                      <div className="min-w-0">
                        <p className="text-[0.9375rem] font-medium">
                          {e.action === 'auth.login' && e.outcome === 'failed' ? 'Failed sign-in attempt' : (ACTION_LABELS[e.action] ?? e.action)}
                          {e.actor === 'assistant' ? <span className="ml-2 text-xs font-normal text-ink-3">by Bridge Intelligence</span> : null}
                        </p>
                        {detail ? <p className="mt-0.5 text-[0.8125rem] break-words text-ink-2">{detail}</p> : null}
                        {e.entityId ? <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-3">{e.entityId}</p> : null}
                      </div>
                      <span className={cx('col-start-2 mt-1 w-fit rounded-full px-2 py-0.5 text-xs font-medium sm:col-start-auto sm:mt-0 sm:self-start', outcomeStyle(e.outcome))}>{e.outcome.replace('_', ' ')}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

// ===========================================================================
// Settings
// ===========================================================================

function ProfileForm() {
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const p = ws.profile;
  const [form, setForm] = useState({ homeCurrency: p.homeCurrency, studyCurrency: p.studyCurrency, monthlySupport: String(p.monthlySupport), supportDay: String(p.supportDay) });
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty = form.homeCurrency !== p.homeCurrency || form.studyCurrency !== p.studyCurrency || form.monthlySupport !== String(p.monthlySupport) || form.supportDay !== String(p.supportDay);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await mutate(() => api('/profile', { method: 'PUT', body: { ...form, supportDay: Number(form.supportDay) } }));
      notify('Settings saved.');
    } catch (err) {
      setFields(err.fields ?? {});
      if (!err.fields) notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const approx = Number(form.monthlySupport);
  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <SelectField label="Home currency, where support comes from" value={form.homeCurrency} onChange={set('homeCurrency')} error={fields.homeCurrency} options={currencyOptions} />
      <SelectField label="Study currency, where costs are paid" value={form.studyCurrency} onChange={set('studyCurrency')} error={fields.studyCurrency} options={currencyOptions} />
      <MoneyField label={`Monthly support in ${form.homeCurrency}`} value={form.monthlySupport} onChange={set('monthlySupport')} error={fields.monthlySupport} />
      <TextField label="Support arrives on day" type="number" min={1} max={28} value={form.supportDay} onChange={set('supportDay')} error={fields.supportDay} hint="1 to 28" />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" busy={busy} disabled={!dirty}>
          Save settings
        </Button>
        {Number.isFinite(approx) && approx > 0 && form.homeCurrency !== form.studyCurrency ? (
          <span className="text-sm text-ink-3">About {formatMoney(round2(approx * midRate(form.homeCurrency, form.studyCurrency)), form.studyCurrency)} at the illustrative rate</span>
        ) : null}
      </div>
    </form>
  );
}

function SettingsPage() {
  const { user, logout } = useAuth();
  const { ws, mutate } = useWorkspace();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await mutate(() => api(open === 'reset' ? '/workspace/reset' : '/workspace/sample', { method: 'POST', body: { confirm: true } }));
      notify(open === 'reset' ? 'Workspace cleared.' : 'Fictional sample data loaded.');
      setOpen(null);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageIntro title="Settings" lead="Your currencies, monthly support, account and workspace data." />
      <div className="grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12">
        <section aria-labelledby="st-money" className="min-w-0 lg:col-span-7">
          <SectionHead id="st-money" title="Currencies and support" />
          <ProfileForm key={JSON.stringify(ws.profile)} />
        </section>
        <section aria-labelledby="st-account" className="min-w-0 lg:col-span-5">
          <SectionHead id="st-account" title="Account" />
          <Rows
            rows={[
              ['Name', user.name],
              ['Email', user.email],
              ['Member since', user.createdAt ? formatDate(user.createdAt.slice(0, 10)) : '—'],
              ['Data', ws.profile.sampleData ? 'Fictional sample data' : 'Your own records'],
            ]}
          />
          <Button
            variant="outline"
            icon={LogOut}
            className="mt-5"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign out
          </Button>
        </section>
        <section aria-labelledby="st-data" className="min-w-0 lg:col-span-12">
          <SectionHead id="st-data" title="Workspace data" note="Both keep your account and activity log." />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={Landmark} onClick={() => setOpen('sample')}>
              Load fictional sample data
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setOpen('reset')}>
              Clear all my records
            </Button>
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={Boolean(open)}
        title={open === 'reset' ? 'Clear all records?' : 'Replace records with sample data?'}
        confirmLabel={open === 'reset' ? 'Clear records' : 'Load sample data'}
        danger={open === 'reset'}
        busy={busy}
        onConfirm={run}
        onCancel={() => setOpen(null)}
      >
        {open === 'reset'
          ? 'Deletes your transactions, budgets, bills, goal, simulations and task log. This cannot be undone.'
          : 'Replaces your current records with three months of fictional data for an Azerbaijani student in Germany.'}
      </ConfirmDialog>
    </>
  );
}

// ===========================================================================
// App
// ===========================================================================

function NotFound() {
  return (
    <div className="py-20">
      <Empty title="This page does not exist" action={<Link to="/" className="font-medium text-forest underline underline-offset-4">Back to overview</Link>}>
        Check the address, or use the menu.
      </Empty>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<RequireAuth />}>
              <Route index element={<OverviewPage />} />
              <Route path="atlas" element={<AtlasPage />} />
              <Route path="budget" element={<BudgetPage />} />
              <Route path="savings" element={<SavingsPage />} />
              <Route path="transfers" element={<TransfersPage />} />
              <Route path="intelligence" element={<IntelligencePage />} />
              <Route path="assistant" element={<Navigate to="/intelligence" replace />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
