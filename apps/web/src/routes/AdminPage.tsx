import { useEffect, useState } from 'react';
import { Lock, Mail } from 'lucide-react';
import { ProductionOverview, type ProductionDestination } from '../components/ProductionOverview.js';
import { supabase } from '../lib/supabase.js';

export function AdminPage({ destination = 'production' }: { readonly destination?: ProductionDestination }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [clubReady, setClubReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) {
        return;
      }

      setAuthenticated(Boolean(data.session));
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session));
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authenticated) {
      void claimClub();
    } else {
      setClubReady(false);
    }
  }, [authenticated]);

  async function claimClub() {
    setLoading(true);
    const { error: claimError } = await supabase.rpc('claim_default_club');

    if (claimError) {
      setError(claimError.message);
      setLoading(false);
      return;
    }

    setClubReady(true);
    setLoading(false);
  }

  async function signIn() {
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    setLoading(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setAuthenticated(false);
    setClubReady(false);
  }

  if (!authenticated) {
    return (
      <main className="home-page">
        <section className="admin-login">
          <div className="brand">
            <img src="/logos/kpl-wordmark.png" alt="" />
            <span>
              <strong>KPL Admin</strong>
              <small>Acceso de administración</small>
            </span>
          </div>
          <label>
            <span>Email</span>
            <div className="input-icon">
              <Mail size={16} />
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoFocus />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="input-icon">
              <Lock size={16} />
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
            </div>
          </label>
          {error ? <div className="empty-panel">{error}</div> : null}
          <button type="button" className="primary-action" onClick={signIn} disabled={loading}>
            Entrar
          </button>
        </section>
      </main>
    );
  }

  if (!clubReady) {
    return (
      <main className="home-page">
        <section className="admin-login">
          <div className="brand"><img src="/logos/kpl-wordmark.png" alt="" /><span><strong>KPL Admin</strong><small>Preparando producción</small></span></div>
          {error ? <div className="empty-panel">{error}</div> : <div className="loading-panel">Cargando producción</div>}
          <button type="button" className="refresh-button" onClick={() => void signOut()}>Salir</button>
        </section>
      </main>
    );
  }

  return <ProductionOverview signOut={signOut} destination={destination} />;
}
