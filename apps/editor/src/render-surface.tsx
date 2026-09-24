import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ProjectSchema } from '@kpl/editor-core';
import type { Project } from '@kpl/editor-core';
import { EditorOverlayFrame } from '@kpl/match-presentation/react';
import './render-surface.css';

const root = createRoot(document.getElementById('root')!);
let project: Project | null = null;

declare global {
  interface Window {
    setRenderProject: (value: unknown) => boolean;
    renderAt: (clipId: string, at: number) => Promise<boolean>;
  }
}
window.setRenderProject = value => { project = ProjectSchema.parse(value); return true; };
window.renderAt = async (clipId, at) => {
  if (!project) throw new Error('No hay proyecto cargado para renderizar');
  const snapshot = project;
  flushSync(() => root.render(<EditorOverlayFrame project={snapshot} clipId={clipId} at={at} />));
  await document.fonts.ready;
  await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return true;
};

window.addEventListener('message', event => {
  const message = event.data as {type?:string;project?:unknown;clipId?:string;at?:number};
  if(message?.type==='kpl-editor-project') window.setRenderProject(message.project);
  if(message?.type==='kpl-editor-time'&&typeof message.clipId==='string'&&typeof message.at==='number') void window.renderAt(message.clipId,message.at);
});
