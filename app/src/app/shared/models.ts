export enum Role {
  ADMIN = 'ADMIN',
  OPERATOR = 'OPERATOR',
}
export function toRole(v: unknown): Role {
  return v === 'ADMIN' ? Role.ADMIN : Role.OPERATOR;
}
export function isRole(v: unknown): v is Role {
  return v === Role.ADMIN || v === Role.OPERATOR;
}

export interface User { id: number; username: string; role: Role; created_at: string }
export interface LoginResult { ok: boolean; token?: string; user?: User; error?: string }
export interface Item { id: number; name: string; created_at: string }
