// ── CrossReach Mission Control ───────────────────────────────────────────────
// Self-serve gate (email+password signup/login, with legacy API-key fallback)
// + sidebar shell + tabbed pages. All /api/v1 calls still authenticate with
// the tenant API key returned at signup/login; the JWT only owns the session.

import { useEffect, useState } from 'react';
import { api, authApi, getApiKey, setApiKey, getToken, clearSession, ApiError, type AuthSession } from './api';
import { OverviewPage } from './pages/Overview';
import { BillingPage } from './pages/Billing';
import { ConnectPage } from './pages/Connect';
import { CrmPage } from './pages/Crm';

type Tab = 'overview' | 'billing' | 'connect' | 'crm';
type GateMode = 'login' | 'signup' | 'apikey';

const TABS: Array<{ id: Tab; label: string; ico: string }> = [
  { id: 'overview', label: 'Overview', ico: '▦' },
  { id: 'billing', label: 'Billing', ico: '$' },
  { id: 'connect', label: 'Connect', ico: '⇄' },
  { id: 'crm', label: 'CRM Sync', ico: '↯' },
];

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  // Restore a persisted JWT session on load (validated against /api/auth/me).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) {
        if (alive) setBooting(false);
        return;
      }
      try {
        const s = await authApi.me();
        if (alive) {
          setSession(s);
          setAuthed(true);
        }
      } catch {
        clearSession();
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const logout = () => {
    clearSession();
    setSession(null);
    setAuthed(false);
  };

  if (booting) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brand"><span className="brand-mark">⬢</span> CrossReach</div>
          <p className="sub" style={{ marginBottom: 0 }}>Restoring session <span className="spin" /></p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return <Gate onAuthed={(s) => { setSession(s); setAuthed(true); }} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">⬢</span> CrossReach</div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="ico">{t.ico}</span> {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {session && (
            <div className="account">
              <div className="account-name">{session.user.name}</div>
              <div className="account-meta">{session.tenant.name}</div>
              <div className="account-meta row" style={{ gap: 6 }}>
                <span className={`pill ${session.tenant.status === 'ACTIVE' ? 'lime' : session.tenant.status === 'SUSPENDED' ? 'rose' : 'amber'}`}>{session.tenant.status}</span>
                <span className="pill teal">{session.tenant.plan}</span>
              </div>
            </div>
          )}
          <div className="api-chip">KEY · {getApiKey().slice(0, 14)}…</div>
          <button className="logout-btn" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {tab === 'overview' && <OverviewPage onGo={setTab} />}
        {tab === 'billing' && <BillingPage />}
        {tab === 'connect' && <ConnectPage />}
        {tab === 'crm' && <CrmPage />}
      </main>
    </div>
  );
}

// ── Gate: email+password login / self-serve signup / API-key fallback ───────

function Gate({ onAuthed }: { onAuthed: (s: AuthSession | null) => void }) {
  const [mode, setMode] = useState<GateMode>('login');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // signup fields
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [confirm, setConfirm] = useState('');
  // apikey field
  const [keyInput, setKeyInput] = useState('');

  const switchMode = (m: GateMode) => {
    setMode(m);
    setErr('');
  };

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (mode === 'apikey') {
        setApiKey(keyInput.trim());
        try {
          await api.get('/billing/plan'); // validates the key
        } catch (validationErr) {
          setApiKey('');
          throw validationErr;
        }
        onAuthed(null);
        return;
      }
      if (mode === 'signup') {
        if (password.length < 8) throw new ApiError(400, 'validation_error', 'Password must be at least 8 characters');
        if (password !== confirm) throw new ApiError(400, 'validation_error', 'Passwords do not match');
        const s = await authApi.signup({ name: name.trim(), companyName: companyName.trim(), email, password });
        onAuthed(s);
        return;
      }
      const s = await authApi.login(email, password);
      onAuthed(s);
    } catch (submitErr) {
      setErr(submitErr instanceof Error ? submitErr.message : 'Unable to reach the CrossReach API');
    } finally {
      setBusy(false);
    }
  };

  const submitLabel =
    mode === 'login' ? 'Sign in →'
      : mode === 'signup' ? 'Create account & enter console →'
        : 'Enter console with API key';

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand"><span className="brand-mark">⬢</span> CrossReach</div>
        <h2>{mode === 'signup' ? 'Create your account' : mode === 'login' ? 'Welcome back' : 'API access'}</h2>
        <p className="sub">
          {mode === 'signup'
            ? 'Provision a workspace and start importing leads in minutes. Starter quota included free — subscribe when you are ready to scale.'
            : mode === 'login'
              ? 'Sign in to manage discovery, connected channels, credits and CRM sync.'
              : 'Authenticate with your tenant API key to manage this workspace.'}
        </p>

        {err && <div className="alert err">{err}</div>}

        <div className="seg" role="tablist">
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m}
              className={`seg-item ${mode === m ? 'active' : ''}`}
              onClick={() => switchMode(m)}
              type="button"
            >
              {m === 'login' ? 'Sign in' : 'Sign up'}
            </button>
          ))}
        </div>

        {mode === 'signup' && (
          <>
            <div className="field">
              <label>Your name</label>
              <input className="input" value={name} placeholder="Jane Cooper" autoFocus
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>Company name</label>
              <input className="input" value={companyName} placeholder="Acme Export Co."
                onChange={(e) => setCompanyName(e.target.value)} />
            </div>
          </>
        )}

        <div className="field">
          <label>Work email</label>
          <input
            className="input"
            type="email"
            value={email}
            placeholder="you@company.com"
            autoFocus={mode !== 'signup'}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Password {mode === 'signup' ? <span className="hint-inline">min 8 characters</span> : null}</label>
          <input
            className="input"
            type="password"
            value={password}
            placeholder="••••••••••"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        {mode === 'signup' && (
          <div className="field">
            <label>Confirm password</label>
            <input
              className="input"
              type="password"
              value={confirm}
              placeholder="••••••••••"
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        )}

        {mode === 'apikey' && (
          <div className="field">
            <label>API key</label>
            <input
              className="input"
              type="password"
              placeholder="x-api-key"
              value={keyInput}
              autoFocus
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        )}

        <button
          className="btn primary"
          style={{ width: '100%' }}
          disabled={busy || (mode === 'signup' && (!name.trim() || !companyName.trim())) || !email.trim() || !password}
          onClick={submit}
        >
          {busy ? <span className="spin" /> : null} {submitLabel}
        </button>

        <div className="gate-switch">
          {mode === 'apikey' ? (
            <button className="link" onClick={() => switchMode('login')} type="button">← Back to sign in</button>
          ) : (
            <button className="link" onClick={() => switchMode('apikey')} type="button">
              Have an API key instead? Use it directly
            </button>
          )}
        </div>

        <div className="demo">
          Demo login: <code>admin@demo.com</code> / <code>changeme</code>
        </div>
      </div>
    </div>
  );
}
