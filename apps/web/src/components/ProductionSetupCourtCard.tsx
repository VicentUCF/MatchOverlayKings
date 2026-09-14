import type { ChangeEvent } from 'react';
import { CircleCheck, CircleDashed } from 'lucide-react';
import type { SetupCourtDraft } from '../lib/production-setup-types.js';

type CourtDraftField = 'captureAuthUserId' | 'captureRef' | 'outputRef' | 'title'
  | 'scheduledStartAt' | 'scheduledEndAt';

type ProductionSetupCourtCardProps = {
  readonly court: SetupCourtDraft;
  readonly complete: boolean;
  readonly captureConfigured: boolean;
  readonly outputConfigured: boolean;
  readonly agentAuthUserId: string;
  readonly onChange: (slug: SetupCourtDraft['slug'], field: CourtDraftField, value: string) => void;
};

export function ProductionSetupCourtCard({
  court, complete, captureConfigured, outputConfigured, agentAuthUserId, onChange,
}: ProductionSetupCourtCardProps) {
  const courtNumber = court.slug.slice(-1);
  const input = (field: CourtDraftField) => (event: ChangeEvent<HTMLInputElement>) => {
    onChange(court.slug, field, event.currentTarget.value);
  };
  return (
    <article className="production-setup-court" aria-label={`Pista ${courtNumber}`} data-setup-court={court.slug}>
      <header className="production-setup-court__header">
        <div><p className="production-setup-court__eyebrow">Pista {courtNumber}</p><h2>Captura y programa</h2></div>
        <span className="production-setup-court__status" data-complete={complete}>
          {complete ? <CircleCheck aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
          {complete ? 'Preparada' : 'Pendiente'}
        </span>
      </header>
      <div className="production-agent-summary">
        <span>Agente compartido</span>
        <output>{agentAuthUserId || 'Pendiente de seleccionar'}</output>
      </div>
      <p className="production-setup-required" id={`${court.slug}-required-help`}>
        Todos los campos editables son obligatorios.
      </p>
      <div className="production-setup-fields">
        <label htmlFor={`${court.slug}-capture-auth`}>Auth UUID de captura</label>
        <input id={`${court.slug}-capture-auth`} value={court.captureAuthUserId} onChange={input('captureAuthUserId')}
          aria-describedby={`${court.slug}-capture-auth-help`} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}" required />
        <small id={`${court.slug}-capture-auth-help`}>Obligatorio. Formato UUID del usuario Auth pre-creado.</small>
        <label htmlFor={`${court.slug}-capture-ref`}>Referencia local de captura</label>
        <input id={`${court.slug}-capture-ref`} value={court.captureRef} onChange={input('captureRef')}
          aria-describedby={`${court.slug}-capture-ref-help`} pattern="local://[A-Za-z0-9](?:[A-Za-z0-9._]|/|-)*"
          placeholder="local://captura" required={!captureConfigured} />
        <small id={`${court.slug}-capture-ref-help`}>Formato requerido: local://captura/pista.</small>
        <label htmlFor={`${court.slug}-title`}>Título</label>
        <input id={`${court.slug}-title`} value={court.title} onChange={input('title')} aria-describedby={`${court.slug}-required-help`} required />
        <label htmlFor={`${court.slug}-start`}>Inicio previsto</label>
        <input id={`${court.slug}-start`} type="datetime-local" value={court.scheduledStartAt} onChange={input('scheduledStartAt')} aria-describedby={`${court.slug}-required-help`} required />
        <label htmlFor={`${court.slug}-end`}>Fin previsto</label>
        <input id={`${court.slug}-end`} type="datetime-local" value={court.scheduledEndAt} onChange={input('scheduledEndAt')} aria-describedby={`${court.slug}-required-help`} required />
        <label htmlFor={`${court.slug}-output-name`}>Salida</label>
        <input id={`${court.slug}-output-name`} value={`Programa ${court.slug}`} readOnly />
        <label htmlFor={`${court.slug}-transport`}>Transporte</label>
        <input id={`${court.slug}-transport`} value="SRT" readOnly />
        <label htmlFor={`${court.slug}-output-ref`}>Referencia local de salida</label>
        <input id={`${court.slug}-output-ref`} value={court.outputRef} onChange={input('outputRef')}
          aria-describedby={`${court.slug}-output-ref-help`} pattern="local://[A-Za-z0-9](?:[A-Za-z0-9._]|/|-)*"
          placeholder="local://programa" required={!outputConfigured} />
        <small id={`${court.slug}-output-ref-help`}>Formato requerido: local://programa/pista.</small>
      </div>
    </article>
  );
}
