// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel } from './types';

type Channel =
    | 'auth:login'
    | 'auth:logout'
    | 'auth:register'
    | 'auth:last-remembered'
    | 'auth:me'
    | 'items:list'
    | 'items:create'
    | 'items:delete';

contextBridge.exposeInMainWorld('api', {
    invoke: <T = unknown>(channel: Channel, payload?: unknown) =>
        ipcRenderer.invoke(channel as IpcChannel, payload)
});

// opzionale: typing globale per window.api
declare global {
    interface Window {
        api: {
            invoke<T = unknown>(channel: Channel, payload?: unknown): Promise<T>;
        };
    }
}
export {};
