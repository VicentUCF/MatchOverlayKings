import type { Clip, Project } from '@kpl/editor-core';
export type MediaInfo = Pick<Clip,'path'|'name'|'duration'|'width'|'height'|'fpsNum'|'fpsDen'|'hasAudio'|'hdr'|'size'>;
export interface ExportProgress { phase:'preparing'|'encoding'|'validating'|'done'|'cancelled'|'error'; fraction:number; message:string; output?:string }
export interface EditorBridge {
  chooseProject(create:boolean):Promise<string|null>;
  openProject(folder:string):Promise<{project:Project;recovered:boolean}>;
  saveProject(folder:string,project:Project):Promise<void>;
  recentProjects():Promise<string[]>;
  bundleResources(folder:string):Promise<Record<string,string>>;
  cacheResources(folder:string,urls:string[]):Promise<Record<string,string>>;
  pickClips():Promise<string[]>;
  pickClipFolder():Promise<string[]>;
  relinkClips(folder:string,project:Project):Promise<Project>;
  verifyClips(project:Project):Promise<string[]>;
  createProxy(folder:string,clip:Clip):Promise<string>;
  droppedFiles(files:File[]):Promise<string[]>;
  inspect(paths:string[]):Promise<{media:MediaInfo[];errors:string[]}>;
  pickOutput():Promise<string|null>;
  mediaUrl(path:string):string;
  exportProject(folder:string,project:Project,output:string):Promise<void>;
  cancelExport():Promise<void>;
  onExportProgress(callback:(progress:ExportProgress)=>void):()=>void;
}
