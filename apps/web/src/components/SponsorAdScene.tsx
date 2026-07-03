import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { animate, stagger } from 'animejs';
import type { SponsorFullscreenState, SponsorTickerState } from '@kpl/shared';
import { resolveSponsors, type SponsorDefinition } from '../lib/sponsors.js';

export function SponsorAdScene({
  ticker,
  fullscreen,
  onFullscreenDone,
}: {
  ticker: SponsorTickerState;
  fullscreen: SponsorFullscreenState | null;
  onFullscreenDone: () => void;
}) {
  return (
    <>
      {!fullscreen ? <SponsorTicker ticker={ticker} /> : null}
      {fullscreen ? <SponsorFullscreenAd ad={fullscreen} onDone={onFullscreenDone} /> : null}
    </>
  );
}

export function hasSponsorTicker(ticker: SponsorTickerState | null | undefined): boolean {
  return Boolean(ticker?.visible && ticker.sponsorIds.length > 0);
}

function SponsorTicker({ ticker }: { ticker: SponsorTickerState }) {
  const sponsors = useMemo(() => resolveSponsors(ticker.sponsorIds), [ticker.sponsorIds]);

  if (!ticker.visible || sponsors.length === 0) {
    return null;
  }

  const tickerStyle = {
    '--ticker-duration': `${ticker.speedSeconds}s`,
  } as CSSProperties;

  return (
    <aside className="sponsor-ticker" style={tickerStyle} aria-label={ticker.label}>
      <div className="sponsor-ticker-label">
        <span>{ticker.label}</span>
      </div>
      <div className="sponsor-ticker-viewport">
        <div className="sponsor-ticker-track">
          <SponsorTickerGroup sponsors={sponsors} />
          <SponsorTickerGroup sponsors={sponsors} ariaHidden />
        </div>
      </div>
    </aside>
  );
}

function SponsorTickerGroup({
  sponsors,
  ariaHidden,
}: {
  sponsors: SponsorDefinition[];
  ariaHidden?: boolean;
}) {
  return (
    <div className="sponsor-ticker-group" aria-hidden={ariaHidden}>
      {sponsors.map((sponsor) => (
        <article
          className="sponsor-ticker-item"
          key={`${sponsor.id}-${ariaHidden ? 'copy' : 'main'}`}
          style={{ '--sponsor-color': sponsor.accentColor } as CSSProperties}
        >
          <SponsorLogo sponsor={sponsor} />
          <strong>{sponsor.name}</strong>
        </article>
      ))}
    </div>
  );
}

function SponsorFullscreenAd({
  ad,
  onDone,
}: {
  ad: SponsorFullscreenState;
  onDone: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const sponsors = useMemo(() => resolveSponsors(ad.sponsorIds), [ad.sponsorIds]);
  const sceneStyle = {
    '--sponsor-color': sponsors[0]?.accentColor ?? '#c9a227',
  } as CSSProperties;

  useEffect(() => {
    const timeoutId = window.setTimeout(onDone, ad.durationSeconds * 1_000);

    if (!ref.current || prefersReducedMotion()) {
      return () => window.clearTimeout(timeoutId);
    }

    const scene = ref.current;
    const animations = [
      animate(scene, {
        opacity: [{ from: 0, to: 1 }],
        duration: 220,
        ease: 'outCubic',
      }),
      animate(scene.querySelectorAll('.sponsor-fullscreen-kicker, .sponsor-fullscreen-title, .sponsor-fullscreen-footer'), {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 18, to: 0 }],
        delay: stagger(80, { start: 140 }),
        duration: 420,
        ease: 'outCubic',
      }),
      animate(scene.querySelectorAll('.sponsor-fullscreen-card'), {
        opacity: [{ from: 0, to: 1 }],
        scale: [{ from: 0.82, to: 1 }],
        delay: stagger(50, { start: 180, from: 'center' }),
        duration: 620,
        ease: 'outExpo',
      }),
    ];

    return () => {
      window.clearTimeout(timeoutId);
      animations.forEach((animation) => animation.revert());
    };
  }, [ad.durationSeconds, ad.id, onDone]);

  return (
    <section
      className="sponsor-fullscreen-ad"
      data-sponsor-fullscreen
      ref={ref}
      style={sceneStyle}
      aria-label="Anuncio patrocinadores"
    >
      <div className="sponsor-fullscreen-shell">
        <span className="sponsor-fullscreen-kicker">Patrocinadores oficiales</span>
        <strong className="sponsor-fullscreen-title">Gracias por apoyar la KPL</strong>
        <div className="sponsor-fullscreen-grid-large">
          {sponsors.map((sponsor) => (
            <article
              className="sponsor-fullscreen-card"
              key={sponsor.id}
              style={{ '--sponsor-color': sponsor.accentColor } as CSSProperties}
            >
              <SponsorLogo sponsor={sponsor} />
              <strong>{sponsor.name}</strong>
            </article>
          ))}
        </div>
      </div>

      <div className="sponsor-fullscreen-footer">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span>kingspadelleague.es</span>
      </div>
    </section>
  );
}

function SponsorLogo({ sponsor }: { sponsor: SponsorDefinition }) {
  if (!sponsor.logoUrl) {
    return <span className="sponsor-logo-fallback">{sponsorInitials(sponsor.name)}</span>;
  }

  return <img src={sponsor.logoUrl} alt="" />;
}

function sponsorInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
