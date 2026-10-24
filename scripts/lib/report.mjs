// Renders an audit as Markdown: overall score, domain table, findings by severity.

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatValue(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

function formatText(value) {
  return value === undefined || value === null || value === '' ? 'n/a' : String(value);
}

function formatPrerequisites(list) {
  return Array.isArray(list) && list.length ? list.join('; ') : 'none';
}

function renderFinding(finding) {
  return [
    `### ${formatText(finding.title)} (\`${formatText(finding.id)}\`, ${finding.domain})`,
    '',
    `- Current: ${formatValue(finding.current)}`,
    `- Recommended: ${formatValue(finding.recommended)}`,
    `- Reason: ${formatText(finding.reason)}`,
    `- Risk: ${formatText(finding.risk)}`,
    `- Prerequisites: ${formatPrerequisites(finding.prerequisites)}`,
    '',
  ];
}

export function renderReport(zoneName, findings, scores) {
  const lines = [
    `# Cloudflare audit: ${zoneName}`,
    '',
    `Overall score: ${scores.overall}/100`,
    '',
    '| Domain | Score |',
    '|---|---|',
    ...Object.entries(scores.domains).map(([domain, score]) => `| ${domain} | ${score} |`),
    '',
  ];
  if (!findings.length) lines.push('No findings.', '');
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    lines.push(`## ${capitalize(severity)} (${group.length})`, '');
    for (const finding of group) lines.push(...renderFinding(finding));
  }
  return lines.join('\n');
}
