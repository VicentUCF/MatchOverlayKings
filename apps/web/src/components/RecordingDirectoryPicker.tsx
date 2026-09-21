import { useId, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderOpen, RotateCcw, X } from 'lucide-react';
import type { ProductionPilotController } from '../hooks/useProductionPilot.js';
import type { RecordingDirectoryListing } from '../lib/production-pilot-adapter.js';

export function RecordingDirectoryPicker({ value, onChange, browse, label = 'Carpeta de grabaciones' }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly browse: ProductionPilotController['recordingDirectories'];
  readonly label?: string;
}) {
  const inputId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<RecordingDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (path?: string) => {
    setLoading(true);
    setError(null);
    const result = await browse(path);
    setLoading(false);
    if (result.kind === 'error') {
      setError(result.message);
      return false;
    }
    setListing(result.value);
    return true;
  };

  const open = async () => {
    const opened = await load(value || undefined);
    if (!opened && value) await load();
    dialogRef.current?.showModal();
  };

  return <div className="recording-directory-field">
    <label id={`${inputId}-label`} htmlFor={inputId}>{label}</label>
    <div className="recording-directory-field__control">
      <FolderOpen aria-hidden="true" />
      <input id={inputId} readOnly value={value} aria-describedby={hintId}
        placeholder="Carpeta predeterminada del equipo de emisión" />
      <button type="button" className="refresh-button" onClick={() => void open()} disabled={loading}>
        <FolderOpen aria-hidden="true" />{loading ? 'Abriendo…' : 'Elegir carpeta'}
      </button>
    </div>
    <small id={hintId}>Elige una carpeta real del equipo de emisión. Se crearán dentro las subcarpetas de pista y sesión.</small>
    <dialog ref={dialogRef} className="recording-directory-dialog" aria-labelledby={`${inputId}-picker-title`}
      onClose={() => setError(null)}>
      <div className="recording-directory-dialog__panel">
        <header>
          <div><p className="production-kicker">Equipo de emisión</p>
            <h2 id={`${inputId}-picker-title`}>Elegir carpeta de grabaciones</h2></div>
          <button type="button" aria-label="Cerrar selector de carpeta" onClick={() => dialogRef.current?.close()}>
            <X aria-hidden="true" />
          </button>
        </header>
        <p className="recording-directory-dialog__current"><span>Ubicación actual</span>
          <code>{listing?.current ?? 'Cargando…'}</code></p>
        <div className="recording-directory-dialog__toolbar">
          <button type="button" className="refresh-button" disabled={loading || !listing?.parent}
            onClick={() => { if (listing?.parent) void load(listing.parent); }}>
            <ArrowUp aria-hidden="true" />Subir
          </button>
          <button type="button" className="refresh-button" disabled={loading} onClick={() => void load()}>
            <RotateCcw aria-hidden="true" />Carpeta predeterminada
          </button>
        </div>
        {error ? <div className="production-page-feedback danger" role="alert">{error}</div> : null}
        <div className="recording-directory-dialog__list" aria-busy={loading}>
          {loading ? <p role="status">Leyendo carpetas…</p> : null}
          {!loading && listing?.directories.length === 0 ? <p>Esta carpeta no contiene otras carpetas.</p> : null}
          {!loading ? listing?.directories.map((directory) => <button type="button" key={directory.path}
            onClick={() => void load(directory.path)}>
            <Folder aria-hidden="true" /><span>{directory.name}</span>
          </button>) : null}
        </div>
        <footer>
          <button type="button" className="refresh-button" onClick={() => dialogRef.current?.close()}>Cancelar</button>
          <button type="button" className="production-setup-submit" disabled={loading || listing === null}
            onClick={() => {
              if (!listing) return;
              onChange(listing.current);
              dialogRef.current?.close();
            }}>
            <FolderOpen aria-hidden="true" />Usar esta carpeta
          </button>
        </footer>
      </div>
    </dialog>
  </div>;
}
