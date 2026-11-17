/**
 * The apps a real workspace can connect today. The server's connect table is typed by this list,
 * so the screen can't offer a Connect button for an app the server has nothing behind.
 */
export const CONNECTABLE = ['gmail', 'gcal', 'outlook', 'gdrive', 'onedrive'] as const;
export type ConnectableApp = (typeof CONNECTABLE)[number];
export const isConnectable = (id: string): id is ConnectableApp => (CONNECTABLE as readonly string[]).includes(id);
