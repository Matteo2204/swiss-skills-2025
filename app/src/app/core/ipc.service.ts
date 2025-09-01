import {Injectable} from '@angular/core';

@Injectable({ providedIn: 'root' })
export class IpcService {
  invoke<T>(channel: string, payload?: any) {
    // @ts-ignore
    const api = window.api;
    if (!api?.invoke) {
      throw new Error(
        'Electron preload API non disponibile. Apri l’app nella finestra Electron (npm run dev) oppure verifica il preload.'
      );
    }
    return api.invoke(channel, payload) as Promise<T>;
  }
}
