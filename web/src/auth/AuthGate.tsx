import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type SessionInfo, type SessionUser } from "../api";
import { loginWithPasskey, passkeyErrorMessage, passkeysSupported } from "./webauthn";

const LAST_USER = "meshmap.lastUser";
const lastUser = () => {
  try {
    return localStorage.getItem(LAST_USER) ?? "";
  } catch {
    return "";
  }
};
const rememberUser = (u: string) => {
  try {
    localStorage.setItem(LAST_USER, u);
  } catch {
    /* ignore */
  }
};

export interface AuthContext {
  user: SessionUser;
  passkeyCount: number;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

interface Props {
  children: (ctx: AuthContext) => ReactNode;
}

function inviteToken(): string | null {
  return new URLSearchParams(window.location.search).get("invite");
}

/** Shows first-run setup, the invite page or sign-in until there is a session, then renders the app. */
export function AuthGate({ children }: Props) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await api.get<SessionInfo>("/api/session"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const signedIn = (s: SessionInfo) => {
    if (s.user) rememberUser(s.user.username);
    if (inviteToken()) window.history.replaceState(null, "", window.location.pathname);
    setSession(s);
  };

  const signOut = useCallback(async () => {
    await api.post("/api/logout").catch(() => undefined);
    setSession(await api.get<SessionInfo>("/api/session").catch(() => ({ setupRequired: false, user: null, passkeyCount: 0 })));
  }, []);

  if (error && !session) {
    return (
      <Shell>
        <p className="err">{error}</p>
        <button onClick={() => void refresh()}>Try again</button>
      </Shell>
    );
  }
  if (!session) return <Shell>Loading…</Shell>;
  if (session.user) return <>{children({ user: session.user, passkeyCount: session.passkeyCount, refresh, signOut })}</>;
  const token = inviteToken();
  if (token) return <InvitePage token={token} onDone={signedIn} />;
  if (session.setupRequired) return <SetupPage onDone={signedIn} />;
  return <LoginPage onDone={signedIn} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="authpage">
      <div className="authcard">
        <h1>meshmap</h1>
        {children}
      </div>
    </div>
  );
}

function PasswordFields(props: { password: string; setPassword: (v: string) => void; label?: string }) {
  const [confirm, setConfirm] = useState("");
  const ok = props.password.length >= 10;
  return (
    <>
      <label className="field">
        <span>{props.label ?? "Password"} (at least 10 characters)</span>
        <input type="password" autoComplete="new-password" value={props.password} onChange={(e) => props.setPassword(e.target.value)} required minLength={10} />
      </label>
      <label className="field">
        <span>Repeat password</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      {props.password && !ok ? <p className="hint">A little longer, please.</p> : null}
      {confirm && confirm !== props.password ? <p className="hint err">The passwords don't match.</p> : null}
      <input type="hidden" data-match={confirm === props.password && ok ? "1" : "0"} />
    </>
  );
}

const matches = (form: HTMLFormElement) => form.querySelector<HTMLInputElement>("input[data-match]")?.dataset.match === "1";

function SetupPage({ onDone }: { onDone: (s: SessionInfo) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell>
      <p>Welcome. Create the first account; it will be the administrator and can add everyone else.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches(e.currentTarget)) return setError("Check the passwords match.");
          setBusy(true);
          setError(null);
          try {
            onDone(await api.post<SessionInfo>("/api/setup", { username, displayName, password }));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Username</span>
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
        </label>
        <PasswordFields password={password} setPassword={setPassword} />
        {error ? <p className="err">{error}</p> : null}
        <button className="on" disabled={busy}>
          Create admin account
        </button>
      </form>
    </Shell>
  );
}

function InvitePage({ token, onDone }: { token: string; onDone: (s: SessionInfo) => void }) {
  const [info, setInfo] = useState<{ username: string; displayName: string } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ username: string; displayName: string }>(`/api/invite/${encodeURIComponent(token)}`).then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);
  if (!info) {
    return (
      <Shell>
        {error ? <p className="err">{error}</p> : "Checking your invite…"}
        {error ? <a href={window.location.pathname}>Go to sign in</a> : null}
      </Shell>
    );
  }
  return (
    <Shell>
      <p>
        Hi {info.displayName}. Choose a password for <b>{info.username}</b>. You can add a passkey (fingerprint, Face ID, Windows Hello) after signing in.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches(e.currentTarget)) return setError("Check the passwords match.");
          setBusy(true);
          setError(null);
          try {
            onDone(await api.post<SessionInfo>(`/api/invite/${encodeURIComponent(token)}/accept`, { password }));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <PasswordFields password={password} setPassword={setPassword} />
        {error ? <p className="err">{error}</p> : null}
        <button className="on" disabled={busy}>
          Set password and sign in
        </button>
      </form>
    </Shell>
  );
}

function LoginPage({ onDone }: { onDone: (s: SessionInfo) => void }) {
  const [username, setUsername] = useState(lastUser());
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPasskey = passkeysSupported();

  const run = async (fn: () => Promise<SessionInfo>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : passkeyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.post<SessionInfo>("/api/login", { username, password }));
        }}
      >
        <label className="field">
          <span>Username</span>
          <input autoComplete="username webauthn" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus={!username} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!username} />
        </label>
        {error ? <p className="err">{error}</p> : null}
        <button className="on" disabled={busy || !password}>
          Sign in
        </button>
      </form>
      {canPasskey ? (
        <>
          <div className="or">or</div>
          <button disabled={busy || !username.trim()} onClick={() => void run(() => loginWithPasskey<SessionInfo>(username.trim()))} title={username.trim() ? "" : "Type your username first"}>
            🔑 Sign in with a passkey
          </button>
          <p className="hint">Uses your fingerprint, face or device PIN. Set one up after signing in with your password.</p>
        </>
      ) : null}
    </Shell>
  );
}
