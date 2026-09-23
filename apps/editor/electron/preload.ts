import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EditorBridge, ExportProgress } from '../src/bridge.js';
const bridge:EditorBridge={
  chooseProject:(create)=>ipcRenderer.invoke('project:choose',create),
  openProject:(folder)=>ipcRenderer.invoke('project:open',folder),
  saveProject:(folder,project)=>ipcRenderer.invoke('project:save',folder,project),
  recentProjects:()=>ipcRenderer.invoke('project:recent'),
  bundleResources:(folder)=>ipcRenderer.invoke('project:resources',folder),
  cacheResources:(folder,urls)=>ipcRenderer.invoke('project:cache',folder,urls),
  pickClips:()=>ipcRenderer.invoke('media:choose'),
  pickClipFolder:()=>ipcRenderer.invoke('media:choose-folder'),
  relinkClips:(folder,project)=>ipcRenderer.invoke('media:relink',folder,project),
  verifyClips:(project)=>ipcRenderer.invoke('media:verify',project),
  createProxy:(folder,clip)=>ipcRenderer.invoke('media:proxy',folder,clip),
  droppedFiles:(files)=>ipcRenderer.invoke('media:authorize-drop',files.map(file=>webUtils.getPathForFile(file)).filter(Boolean)),
  inspect:(paths)=>ipcRenderer.invoke('media:inspect',paths),
  pickOutput:()=>ipcRenderer.invoke('output:choose'),
  mediaUrl:(path)=>`kpl-media://local/${encodeURIComponent(path)}`,
  exportProject:(folder,project,output)=>ipcRenderer.invoke('export:start',folder,project,output),
  cancelExport:()=>ipcRenderer.invoke('export:cancel'),
  onExportProgress:(callback)=>{const handler=(_event:Electron.IpcRendererEvent,progress:ExportProgress)=>callback(progress);ipcRenderer.on('export:progress',handler);return()=>ipcRenderer.off('export:progress',handler);},
};
contextBridge.exposeInMainWorld('editorBridge',bridge);
