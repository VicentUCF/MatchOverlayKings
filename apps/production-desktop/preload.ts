import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kplDesktop', {
  openRecording: (id: string) => ipcRenderer.invoke('recording:open', id),
  exportRecording: (id: string) => ipcRenderer.invoke('recording:export', id),
  importYouTubeCredentials: () => ipcRenderer.invoke('youtube:import-credentials'),
});
