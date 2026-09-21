import { lazy, Suspense, type ReactNode } from 'react';

const AdminPage = lazy(async () => ({ default: (await import('./AdminPage.js')).AdminPage }));
const ControlPage = lazy(async () => ({ default: (await import('./ControlPage.js')).ControlPage }));
const HomePage = lazy(async () => ({ default: (await import('./HomePage.js')).HomePage }));
const LivePage = lazy(async () => ({ default: (await import('./LivePage.js')).LivePage }));
const OverlayPage = lazy(async () => ({ default: (await import('./OverlayPage.js')).OverlayPage }));
const MobileCameraPage = lazy(async () => ({ default: (await import('./MobileCameraPage.js')).MobileCameraPage }));
const PostproductionOverlayPage = lazy(async () => ({ default: (await import('./PostproductionOverlayPage.js')).PostproductionOverlayPage }));

export function App() {
  const path = window.location.pathname;
  const controlMatch = path.match(/^\/control\/([a-z0-9-]+)$/i);
  const liveMatch = path.match(/^\/live\/([a-z0-9-]+)$/i);
  const overlayMatch = path.match(/^\/overlay\/([a-z0-9-]+)\/scoreboard$/i);
  const postproductionOverlayMatch = path.match(/^\/postproduction\/([a-f0-9-]+)\/overlay$/i);

  if (path === '/') {
    return route(<HomePage />);
  }

  if (path === '/admin') {
    return route(<AdminPage destination="production" />);
  }

  if (path === '/admin/grabaciones') {
    return route(<AdminPage destination="recordings" />);
  }

  if (path === '/admin/emisiones' || path === '/mandos') {
    window.location.replace(`/admin${window.location.search}`);
    return null;
  }

  if (path === '/admin/sistema' || path === '/admin/sistema/configuracion') {
    window.location.replace('/admin');
    return null;
  }

  if (path === '/camera/pilot') {
    return route(<MobileCameraPage />);
  }

  if (controlMatch?.[1]) {
    return route(<ControlPage eventId={controlMatch[1]} />);
  }

  if (liveMatch?.[1]) {
    return route(<LivePage eventId={liveMatch[1]} />);
  }

  if (overlayMatch?.[1]) {
    return route(<OverlayPage eventId={overlayMatch[1]} />);
  }

  if (postproductionOverlayMatch?.[1]) {
    return route(<PostproductionOverlayPage projectId={postproductionOverlayMatch[1]} />);
  }

  window.location.replace('/');
  return null;
}

function route(content: ReactNode) {
  return <Suspense fallback={<main className="production-pilot-loading" aria-busy="true">Cargando…</main>}>
    {content}
  </Suspense>;
}
