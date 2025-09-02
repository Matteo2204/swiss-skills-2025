// electron/types.ts
export type Role = 'ADMIN' | 'OPERATOR';

export const IPC = {
    AUTH_LOGIN:    'auth:login',
    AUTH_LOGOUT:   'auth:logout',
    AUTH_REGISTER: 'auth:register',
    AUTH_ME:       'auth:me',
    ITEMS_LIST:    'items:list',
    ITEMS_CREATE:  'items:create',
    ITEMS_DELETE:  'items:delete',
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];
