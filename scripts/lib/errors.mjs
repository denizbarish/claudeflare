const PERMISSION_CODES = new Set([9109, 10000]);
const PLAN_PATTERN = /plan|entitle|not available/i;

export class CfError extends Error {
  constructor(code, message = code, { status = 0, cfCodes = [], hint = '' } = {}) {
    super(message);
    this.name = 'CfError';
    this.code = code;
    this.status = status;
    this.cfCodes = cfCodes;
    this.hint = hint;
  }
}

function errorList(body) {
  return Array.isArray(body?.errors) ? body.errors : [];
}

export function mapError(status, body) {
  const errors = errorList(body);
  const cfCodes = errors.map((e) => e?.code).filter((c) => typeof c === 'number');
  const messages = errors.map((e) => e?.message).filter((m) => typeof m === 'string' && m);
  const message = messages.length ? messages.join('; ') : `HTTP ${status}`;
  const details = { status, cfCodes };

  if (cfCodes.some((c) => PERMISSION_CODES.has(c)) || status === 403) {
    const missing = messages.length ? messages.join('; ') : 'unknown permission';
    const hint = `Token is missing a required permission (${missing}); see docs/token-template.md`;
    return new CfError('permission', message, { ...details, hint });
  }
  if (status === 429) return new CfError('rate_limit', message, details);
  if (status === 404) return new CfError('not_found', message, details);
  if (messages.some((m) => PLAN_PATTERN.test(m))) return new CfError('plan', message, details);
  return new CfError('api', message, details);
}
