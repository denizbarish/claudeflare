// Audit scoring: each domain starts at 100 and loses points per finding.

import { CfError } from './errors.mjs';

export const SEVERITY_WEIGHTS = { critical: 25, high: 10, medium: 4, low: 1 };
const MAX_SCORE = 100;

// domains: audited domain names; one without findings scores 100.
export function scoreDomains(findings, domains = []) {
  const penalties = Object.fromEntries(domains.map((d) => [d, 0]));
  for (const finding of findings) {
    const weight = SEVERITY_WEIGHTS[finding?.severity];
    const domain = finding?.domain;
    if (weight === undefined || typeof domain !== 'string' || !domain) {
      throw new CfError(
        'invalid_finding',
        `Finding ${JSON.stringify(finding?.id)} needs a domain and a severity of ${Object.keys(SEVERITY_WEIGHTS).join(', ')}`,
      );
    }
    penalties[domain] = (penalties[domain] ?? 0) + weight;
  }
  const scores = {};
  for (const domain of Object.keys(penalties).sort()) {
    scores[domain] = Math.max(0, MAX_SCORE - penalties[domain]);
  }
  const values = Object.values(scores);
  const overall = values.length
    ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
    : MAX_SCORE;
  return { domains: scores, overall };
}
