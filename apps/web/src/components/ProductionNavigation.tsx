import { Ellipsis, Film, LogOut, Radio, RefreshCw, UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export type ProductionArea = 'production' | 'recordings' | 'system' | 'visual';
export type ProductionNavigationRole = 'admin' | 'operator' | 'viewer';

type ProductionNavigationProps = {
  readonly active: ProductionArea;
  readonly role: ProductionNavigationRole;
  readonly onRefresh?: (() => void) | undefined;
  readonly refreshing?: boolean;
  readonly onSignOut?: (() => void) | undefined;
  readonly trailing?: ReactNode;
  readonly currentLabel?: string;
  readonly onAreaChange?: ((area: 'production' | 'recordings') => void) | undefined;
};

const ADMIN_LINKS = [
  { area: 'production', href: '/admin', label: 'Producción', icon: Radio },
  { area: 'recordings', href: '/admin/grabaciones', label: 'Grabaciones', icon: Film },
] as const;

export function ProductionNavigation({
  active, role, onRefresh, refreshing = false, onSignOut, trailing, currentLabel = 'Control visual', onAreaChange,
}: ProductionNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const links = role === 'admin'
    ? ADMIN_LINKS
    : ADMIN_LINKS.filter(({ area }) => area === 'production');
  const hasSessionMenu = onRefresh !== undefined || onSignOut !== undefined;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <header className="home-topbar production-navigation">
      <a className="brand production-navigation__brand" href="/admin" aria-label="KPL Control Center">
        <img src="/logos/kpl-wordmark.png" alt="" width="144" height="54" />
        <span>
          <strong>{role === 'operator' ? 'KPL Mandos' : 'KPL Control Center'}</strong>
          <small>{role === 'operator' ? 'Control visual asignado' : 'Centro de producción'}</small>
        </span>
      </a>
      {onAreaChange && role === 'admin' ? (
        <div className="production-navigation__areas" role="tablist" aria-label="Centro de producción">
          {ADMIN_LINKS.map(({ area, label, icon: Icon }) => (
            <button key={area} id={`production-tab-${area}`} type="button" role="tab"
              aria-selected={active === area} aria-controls={`production-panel-${area}`}
              tabIndex={active === area ? 0 : -1} data-area={area}
              onKeyDown={handleTabKeyDown} onClick={() => onAreaChange(area)}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </div>
      ) : (
        <nav className="production-navigation__areas" aria-label="Navegación principal">
          {links.map(({ area, href, label, icon: Icon }) => (
            <a key={area} href={href} aria-current={active === area ? 'page' : undefined}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </a>
          ))}
          {active === 'visual' ? <span className="production-navigation__current" aria-current="page">{currentLabel}</span> : null}
        </nav>
      )}
      <div className="production-navigation__actions">
        {trailing}
        {hasSessionMenu ? <div className="production-navigation__menu-shell" ref={menuRef}>
          <button ref={menuButtonRef} type="button" className="refresh-button production-navigation__menu-trigger"
            aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((open) => !open)}>
            <Ellipsis aria-hidden="true" /><span>Opciones</span>
          </button>
          <div id={menuId} className="production-navigation__menu" hidden={!menuOpen}>
            <div className="production-navigation__session">
              <UserRound aria-hidden="true" />
              <span><small>Sesión</small><strong>{roleLabel(role)}</strong></span>
            </div>
            {onRefresh ? <button type="button" onClick={() => {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
              onRefresh();
            }} disabled={refreshing}>
              <RefreshCw aria-hidden="true" />{refreshing ? 'Actualizando' : 'Actualizar datos'}
            </button> : null}
            {onSignOut ? <button type="button" onClick={() => { setMenuOpen(false); onSignOut(); }}>
              <LogOut aria-hidden="true" />Cerrar sesión
            </button> : null}
          </div>
        </div> : null}
      </div>
    </header>
  );
}

function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []];
  if (tabs.length === 0) return;
  const current = tabs.indexOf(event.currentTarget);
  const target = event.key === 'Home' ? tabs[0]
    : event.key === 'End' ? tabs.at(-1)
      : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  event.preventDefault();
  target?.focus();
  target?.click();
}

function roleLabel(role: ProductionNavigationRole): string {
  if (role === 'admin') return 'Administrador';
  if (role === 'operator') return 'Operador';
  return 'Viewer';
}
