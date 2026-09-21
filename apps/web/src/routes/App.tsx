import { AdminPage } from './AdminPage.js';
import { ControlPage } from './ControlPage.js';
import { HomePage } from './HomePage.js';
import { LivePage } from './LivePage.js';
import { OverlayPage } from './OverlayPage.js';
import { MobileCameraPage } from './MobileCameraPage.js';

export function App() {
  const path = window.location.pathname;
  const controlMatch = path.match(/^\/control\/([a-z0-9-]+)$/i);
  const liveMatch = path.match(/^\/live\/([a-z0-9-]+)$/i);
  const overlayMatch = path.match(/^\/overlay\/([a-z0-9-]+)\/scoreboard$/i);

  if (path === '/') {
    return <HomePage />;
  }

  if (path === '/admin') {
    return <AdminPage destination="production" />;
  }

  if (path === '/admin/grabaciones') {
    return <AdminPage destination="recordings" />;
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
    return <MobileCameraPage />;
  }

  if (controlMatch?.[1]) {
    return <ControlPage eventId={controlMatch[1]} />;
  }

  if (liveMatch?.[1]) {
    return <LivePage eventId={liveMatch[1]} />;
  }

  if (overlayMatch?.[1]) {
    return <OverlayPage eventId={overlayMatch[1]} />;
  }

  window.location.replace('/');
  return null;
}
