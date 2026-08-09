import { useState } from 'react';
import { api, type AuthState } from '../api/client';
import { IconImage } from '../components/icons';

interface LoginViewProps {
  onSignedIn: (state: AuthState) => void;
}

/**
 * There is no username field: the access code identifies the person as well as
 * proving who they are, so sharing the gallery means sending one string.
 */
export function LoginView({ onSignedIn }: LoginViewProps): React.ReactElement {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || code.trim() === '') return;

    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(code));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            <IconImage size={18} />
          </span>
          <span>Photo Gallery</span>
        </div>

        <label htmlFor="access-code">Access code</label>
        <input
          id="access-code"
          type="password"
          className="login-input"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          autoComplete="current-password"
          autoFocus
          spellCheck={false}
          disabled={busy}
        />

        <p className="login-hint">Dashes and capitalisation don&rsquo;t matter.</p>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || code.trim() === ''}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
