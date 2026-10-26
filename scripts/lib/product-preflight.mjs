// Preflight for product (v3) ops, run by `plan new`, `claudeflare preflight`
// and again by apply. Per product the plan touches, in order: entitlement,
// a permission probe, the module's account reads (gather), confirm_name
// against the live name, dependency scans and lockout analysis (spec 6, 9).
// Reads only; a failed step skips the later steps of that product.

import { CfError } from './errors.mjs';
import { classifyProductOp } from './products/index.mjs';
import { getPath } from './products/fields.mjs';

export const LOCKOUT_PREFIX = 'Lockout risk:';

export function hasProductOps(plan, ops = plan?.ops) {
  return (ops ?? []).some((op) => classifyProductOp(op, plan));
}

// Thrown CfErrors become failed checks; anything else is a bug and propagates.
// A 403 anywhere in preflight means the token lacks a permission.
function failureCode(err) {
  if (!(err instanceof CfError)) throw err;
  return err.code === 'permission' ? 'missing_permission' : err.code;
}

function permissionName(module) {
  return module.permission?.edit ?? module.permission?.read ?? module.product;
}

// One line each: messages split the risk on newlines.
function asLockoutLine(line) {
  const flat = line.trim().replace(/\s*\n\s*/g, ' ');
  return flat.startsWith(LOCKOUT_PREFIX) ? flat : `${LOCKOUT_PREFIX} ${flat}`;
}

// Product ops grouped by module, in plan order.
function groupByProduct(plan, ops) {
  const groups = new Map();
  ops.forEach((op, index) => {
    const classified = classifyProductOp(op, plan);
    if (!classified) return;
    if (!groups.has(classified.module)) groups.set(classified.module, []);
    groups.get(classified.module).push({ op, index, classified });
  });
  return groups;
}

async function confirmNames(client, items, add) {
  const destructive = items.filter(({ classified }) => classified.entry.destructive && classified.entry.nameField);
  if (!destructive.length) return true;
  const problems = [];
  for (const { op, index, classified } of destructive) {
    const { entry, match, base } = classified;
    const readPath = entry.read ? entry.read(match, base) : String(op.path).split('?')[0];
    let before;
    try {
      before = await client.request('GET', readPath);
    } catch (err) {
      problems.push({ code: failureCode(err), text: `op ${index}: could not read ${readPath} (${err.message})` });
      continue;
    }
    const live = getPath(before, entry.nameField);
    if (op.confirm_name !== live) {
      problems.push({ code: 'invalid_op', text: `op ${index}: confirm_name ${JSON.stringify(op.confirm_name)} does not match the live name ${JSON.stringify(live ?? null)}` });
    }
  }
  if (problems.length) {
    add('confirm_name', false, `${problems[0].code}: ${problems.map((p) => p.text).join('; ')}`, problems[0].code);
    return false;
  }
  add('confirm_name', true, `${destructive.length} name(s) match`);
  return true;
}

async function productChecks(client, module, items, out, add) {
  const { product } = module;
  const base = items[0].classified.base;
  const fail = (name, code, text) => add(name, false, `${code}: ${product}: ${text}`, code);

  if (module.entitlement) {
    let ent;
    try {
      ent = await module.entitlement(client, base);
    } catch (err) {
      return fail('entitlement', failureCode(err), err.message);
    }
    if (!ent?.ok) return fail('entitlement', 'not_entitled', ent?.detail ?? 'not available on this account');
    add('entitlement', true, `${product}: ${ent.detail}`);
  }

  const probe = module.probePath(base);
  try {
    await client.request('GET', probe);
    add('permission', true, `${product}: token can read ${probe}`);
  } catch (err) {
    const code = failureCode(err);
    if (code === 'missing_permission') return fail('permission', code, `the token cannot read ${probe}; it needs "${permissionName(module)}"`);
    return fail('permission', code, err.message);
  }

  const ops = items.map((i) => i.op);
  let ctx;
  try {
    ctx = (await module.gather(client, base, ops)) ?? {};
  } catch (err) {
    return fail('gather', failureCode(err), err.message);
  }
  out.ctx[product] = ctx;
  add('gather', true, `${product}: account state read`);

  if (!(await confirmNames(client, items, add))) return undefined;

  if (module.dependencies) {
    const inUse = [];
    for (const { op, classified } of items) {
      const users = module.dependencies(ctx, op, classified.entry) ?? [];
      if (!users.length) continue;
      const key = `${String(op.method).toUpperCase()} ${op.path}`;
      out.dependencies[key] = users;
      inUse.push(`${key} is used by ${users.join(', ')}`);
    }
    if (inUse.length) return fail('dependencies', 'resource_in_use', inUse.join('; '));
    add('dependencies', true, `${product}: nothing in use`);
  }

  const lines = module.lockoutRisks(ctx, ops) ?? [];
  for (const line of lines) {
    if (typeof line === 'string' && line.trim()) out.lockout_risks.push(asLockoutLine(line));
  }
  return undefined;
}

// plan: the plan or its target ({ scope, account_id } / { scope, zone_id }).
// Failed checks carry `code` (not_entitled, missing_permission,
// resource_in_use, invalid_op, ...) so apply can throw it unchanged.
export async function runProductPreflight(client, plan, ops) {
  const out = { checks: [], lockout_risks: [], dependencies: {}, ctx: {} };
  const add = (name, ok, detail, code) => out.checks.push(ok ? { name, ok, detail } : { name, ok, detail, code });
  for (const [module, items] of groupByProduct(plan, ops ?? [])) {
    await productChecks(client, module, items, out, add);
  }
  out.lockout_risks = [...new Set(out.lockout_risks)];
  return out;
}
