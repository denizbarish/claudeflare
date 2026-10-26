// Lockout line prefix, shared by product preflight and the hooks. No imports:
// the hooks load it on every call and must never pull in product modules.
export const LOCKOUT_PREFIX = 'Lockout risk:';
