import {Injectable} from '@angular/core';
import {getAvatar} from '../../../../shared/api/lawnmower-api';

@Injectable({ providedIn: 'root' })
export class AvatarCacheService {
  // Cache in-memory Data URLs; null means no avatar (204)
  private cache = new Map<number, string | null>();
  private inflight = new Map<number, Promise<string | null>>();

  peek(id: number): string | null | undefined {
    return this.cache.get(id);
  }

  async getUrl(id: number): Promise<string | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const existing = this.inflight.get(id);
    if (existing) return existing;

    const p = (async () => {
      try {
        const blob = await getAvatar(id);
        if (!blob) {
          this.cache.set(id, null);
          return null;
        }
        const url = await this.blobToDataURL(blob);
        this.cache.set(id, url);
        return url;
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, p);
    return p;
  }

  async warm(ids: number[]): Promise<void> {
    const missing = ids.filter(id => !this.cache.has(id));
    await Promise.allSettled(missing.map(id => this.getUrl(id)));
  }

  // Allow external updates after uploads/deletions
  setDataUrl(id: number, dataUrl: string | null): void {
    this.cache.set(id, dataUrl);
  }

  private blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Invalidate a specific id (after upload/delete)
  invalidate(id: number): void {
    this.cache.delete(id);
    this.inflight.delete(id);
  }
}
