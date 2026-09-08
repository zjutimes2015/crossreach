// ── API client ────────────────────────────────────────────────────────────────
// Reads the tenant API key from localStorage (set on the login gate) and talks
// to the CrossReach backend through the Vite proxy (/api → localhost:3000).

const KEY_STORAGE = 'cr_api_key';
const BASE = '/api/v1';

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setApiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
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
