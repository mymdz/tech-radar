export type Log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

/** One JSON object per line, like the other services on the host. */
export const log: Log = (level, message, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields }));
};
