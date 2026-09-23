import { renderThumbnailPng } from '@kpl/production-assets';
import type { Project } from '@kpl/editor-core';
import { buildEditorOverlaySvg } from './index.js';
export function renderEditorOverlayPng(project:Project,clipId:string,at:number,width:number,height:number,fontFiles?:readonly string[]):Uint8Array{return renderThumbnailPng(buildEditorOverlaySvg(project,clipId,at,width,height),fontFiles);}
