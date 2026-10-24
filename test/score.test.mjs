import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDomains } from '../scripts/lib/score.mjs';
import { renderReport } from '../scripts/lib/report.mjs';

const f = (domain, severity, extra = {}) => ({ id: `${domain}.${severity}`, domain, severity, title: `${domain} ${severity}`, ...extra });

test('scoreDomains: ssl with 1 critical + 1 low = 74; empty domain list overall 100', () => {
  assert.deepEqual(scoreDomains([f('ssl', 'critical'), f('ssl', 'low')]), { domains: { ssl: 74 }, overall: 74 });
  assert.deepEqual(scoreDomains([]), { domains: {}, overall: 100 });
});

test('scoreDomains: audited domains without findings score 100 and count toward overall', () => {
  const result = scoreDomains([f('ssl', 'critical')], ['ssl', 'dns', 'cache']);
  assert.deepEqual(result, { domains: { ssl: 75, dns: 100, cache: 100 }, overall: 92 });
  assert.deepEqual(scoreDomains([f('waf', 'low')], ['dns']), { domains: { dns: 100, waf: 99 }, overall: 100 });
});

test('scoreDomains floors at 0', () => {
  const findings = Array.from({ length: 5 }, () => f('waf', 'critical'));
  assert.deepEqual(scoreDomains(findings).domains, { waf: 0 });
});

test('scoreDomains: overall is the rounded mean of domain scores', () => {
  // ssl 90, cache 96, dns 99 -> mean 95
  const result = scoreDomains([f('ssl', 'high'), f('cache', 'medium'), f('dns', 'low')]);
  assert.deepEqual(result, { domains: { cache: 96, dns: 99, ssl: 90 }, overall: 95 });
  assert.equal(scoreDomains([f('ssl', 'high'), f('dns', 'medium'), f('dns', 'low')]).overall, 93);
});

test('scoreDomains rejects an unknown severity', () => {
  assert.throws(() => scoreDomains([f('ssl', 'urgent')]), (err) => err.code === 'invalid_finding');
});

test('renderReport: overall score, domain table, findings by severity with details', () => {
  const findings = [
    f('cache', 'low', { current: 'off', recommended: 'on', reason: 'r-low', risk: 'none', prerequisites: [] }),
    f('ssl', 'critical', {
      title: 'SSL mode is Flexible',
      current: 'flexible',
      recommended: 'strict',
      reason: 'Unencrypted to origin.',
      risk: '526 if origin cert is invalid.',
      prerequisites: ['Origin certificate installed'],
    }),
  ];
  const md = renderReport('example.com', findings, scoreDomains(findings));
  assert.match(md, /example\.com/);
  assert.match(md, /Overall score: 87\/100/);
  assert.match(md, /\| ssl \| 75 \|/);
  assert.match(md, /\| cache \| 99 \|/);
  const crit = md.indexOf('## Critical');
  const low = md.indexOf('## Low');
  assert.ok(md.indexOf('Overall score') < md.indexOf('| Domain |'));
  assert.ok(md.indexOf('| Domain |') < crit && crit < low);
  assert.equal(md.indexOf('## High'), -1);
  const ssl = md.slice(crit, low);
  for (const text of ['SSL mode is Flexible', 'flexible', 'strict', 'Unencrypted to origin.', '526 if origin', 'Origin certificate installed']) {
    assert.ok(ssl.includes(text), `missing ${text}`);
  }
  assert.match(md.slice(low), /Prerequisites: none/);
});
