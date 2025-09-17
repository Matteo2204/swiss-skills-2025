// electron/types.ts
export type Role = 'ADMIN' | 'OPERATOR';

export const IPC = {
    AUTH_LOGIN:    'auth:login',
    AUTH_LOGOUT:   'auth:logout',
    AUTH_REGISTER: 'auth:register',
    AUTH_LAST_REMEMBERED: 'auth:last-remembered',
    AUTH_ME:       'auth:me',
    EXPORT_SAVE_JSON: 'export:save-json',
    CONFIG_READ:   'config:read',
    CONFIG_WRITE:  'config:write',
    DIALOG_SAVE_PATH: 'dialog:save-path',
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];
