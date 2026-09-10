// ── API client ────────────────────────────────────────────────────────────────
// Reads the tenant API key from localStorage (set after signup/login) and talks
// to the CrossReach backend through the Vite proxy (/api → localhost:3000).
// Session (JWT) + identity are kept alongside for /api/auth/me and the header.

const KEY_STORAGE = 'cr_api_key';
const TOKEN_STORAGE = 'cr_token';
const SESSION_STORAGE = 'cr_session';
const BASE = '/api/v1';
const AUTH_BASE = '/api/auth';

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setApiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
}

// ── Dashboard session (JWT from /api/auth) ──────────────────────────────────
// The backend returns `{ token, apiKey, user, tenant }` on signup/login/me.
// The apiKey stays the credential for all /api/v1/* calls (unchanged app
// architecture); the token + identity power the gate and the account bar.

export function getToken(): string {
  return localStorage.getItem(TOKEN_STORAGE) ?? '';
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_STORAGE, token);
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  authProvider: string;
}

export interface AuthTenant {
  id: string;
  name: string;
  plan: string;
  status: string;
}

export interface AuthSession {
  token: string;
  apiKey: string;
  user: AuthUser;
  tenant: AuthTenant;
}

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    return null;
  }
}

function setSession(session: AuthSession) {
  // Keep legacy storage in sync so every existing page keeps working.
  setToken(session.token);
  setApiKey(session.apiKey);
  localStorage.setItem(SESSION_STORAGE, JSON.stringify(session));
}

export function clearSession() {
  clearApiKey();
  localStorage.removeItem(TOKEN_STORAGE);
  localStorage.removeItem(SESSION_STORAGE);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': getApiKey(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { code?: string; message?: string } } & T;

  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'request_failed',
      data?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ── Auth (no x-api-key — these endpoints sit outside the tenant scope) ──────

async function authRequest<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { code?: string; message?: string } } & T;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: { code?: string } }).error?.code ?? 'request_failed',
      (data as { error?: { message?: string } }).error?.message ?? `Request failed (${res.status})`,
    );
  }
  return data;
}

export const authApi = {
  /** Email + password login → persists apiKey + JWT session. */
  async login(email: string, password: string): Promise<AuthSession> {
    const session = await authRequest<AuthSession>('POST', '/login', { email, password });
    setSession(session);
    return session;
  },
  /** Self-serve signup → provisions tenant + admin and signs the user in. */
  async signup(input: { name: string; companyName: string; email: string; password: string }): Promise<AuthSession> {
    const session = await authRequest<AuthSession>('POST', '/signup', input);
    setSession(session);
    return session;
  },
  /** Refresh the session from the JWT — used on page reload. */
  async me(): Promise<AuthSession> {
    const session = await authRequest<AuthSession>('GET', '/me', undefined, getToken());
    setSession(session);
    return session;
  },
};

// ── Typed responses ──────────────────────────────────────────────────────────

export interface BalanceSnapshot {
  purchased: number;
  granted: number;
  available: number;
  consumedThisCycle: number;
  monthlyGrant: number;
  cycleEndsAt: string | null;
  plan: string;
}

// ── Creem (second PSP — fixed credit packs only) ────────────────────────────

export interface CreemPack {
  productId: string;
  credits: number;
  label: string;
  priceCents?: number | null;
}

export const creemApi = {
  /** Fixed packs the operator configured via CREEM_TOPUP_PACKS ([] = hidden). */
  async packs(): Promise<CreemPack[]> {
    const data = await api.get<{ packs: CreemPack[] }>('/billing/creem/packs');
    return data?.packs ?? [];
  },
  /** Create a Creem Checkout session for a pack → redirect to the returned url. */
  async checkout(productId: string, successUrl: string): Promise<{ checkoutId: string; url: string }> {
    return api.post<{ checkoutId: string; url: string }>('/billing/creem/checkout', {
      productId,
      successUrl,
    });
  },
};

export interface UsageSummary {
  resource: string;
  credits: number;
  events: number;
  lastUsedAt?: string | null;
}

export interface CreditTxn {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}

export interface ConnectAccount {
  id: string;
  channel: string;
  name: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
  config?: Record<string, unknown>;
}

export interface CrmIntegration {
  id: string;
  crm: string;
  externalId: string;
  active: boolean;
  createdAt: string;
}

// ── Compliance (外呼合规证据链) ─────────────────────────────────────────────

export interface SuppressionEntry {
  id: string;
  channel: string;
  contact: string;
  reason: string;
  source: string | null;
  note: string | null;
  active: boolean;
  createdAt: string;
  removedAt: string | null;
}

export interface EvidenceItem {
  ts: string;
  kind: string;
  channel: string;
  contact: string;
  accountId?: string | null;
  refId?: string | null;
  status?: string | null;
  detail?: string | null;
}

export interface ComplianceFilters {
  channel?: string;
  reason?: string;
  contact?: string;
  includeInactive?: boolean;
  limit?: number;
  from?: string;
  to?: string;
}

function toQuery(filters: ComplianceFilters): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '') return;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  push('channel', filters.channel);
  push('reason', filters.reason);
  push('contact', filters.contact);
  push('includeInactive', filters.includeInactive);
  push('limit', filters.limit);
  push('from', filters.from);
  push('to', filters.to);
  return parts.join('&');
}

export const complianceApi = {
  async suppressions(filters: ComplianceFilters = {}): Promise<SuppressionEntry[]> {
    const data = await api.get<{ suppressions: SuppressionEntry[] }>(
      `/compliance/suppressions${filters ? `?${toQuery(filters)}` : ''}`,
    );
    return data.suppressions;
  },

  async addSuppression(input: {
    channel: string;
    contact: string;
    reason?: string;
    note?: string;
  }): Promise<SuppressionEntry> {
    const data = await api.post<{ suppression: SuppressionEntry }>('/compliance/suppressions', {
      channel: input.channel,
      contact: input.contact,
      reason: input.reason ?? 'MANUAL',
      note: input.note || undefined,
    });
    return data.suppression;
  },

  async removeSuppression(id: string): Promise<void> {
    await api.del(`/compliance/suppressions/${id}`);
  },

  async evidence(filters: ComplianceFilters = {}): Promise<{ items: EvidenceItem[]; truncated: boolean }> {
    return api.get<{ items: EvidenceItem[]; truncated: boolean }>(
      `/compliance/evidence?${toQuery(filters)}`,
    );
  },

  /** Fetch the evidence CSV and trigger a browser download. */
  async exportEvidence(filters: ComplianceFilters = {}): Promise<void> {
    const res = await fetch(`${BASE}/compliance/evidence/export?${toQuery(filters)}`, {
      headers: { 'x-api-key': getApiKey() },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ApiError(res.status, data?.error?.code ?? 'request_failed', data?.error?.message ?? `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crossreach-compliance.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
