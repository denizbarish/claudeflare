# Load balancer with no healthy pool

Symptom: a load balanced hostname serves errors (often 530 or 503), traffic lands on the fallback pool, or health shows every pool `Unhealthy` or `Critical`.

## Evidence

1. The load balancer and its pools:
   ```js
   async () => {
     const lbs = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/load_balancers" });
     const pools = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/pools" });
     const monitors = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/monitors" });
     return { lbs: lbs.result, pools: pools.result, monitors: monitors.result };
   }
   ```
   Record the LB's `default_pools`, `fallback_pool`, `steering_policy` and `enabled`; per pool `enabled`, `minimum_origins`, `monitor`, `check_regions` and each origin's `address`, `enabled` and `weight`; per monitor `type`, `path`, `port`, `expected_codes`, `expected_body`, `header` (Host), `timeout`, `interval`, `retries`.
2. Health per pool and region: GET `/accounts/ACCOUNT_ID/load_balancers/pools/POOL_ID/health` (`pop_health` per region, `healthy` per origin with `failure_reason` and `response_code`).
3. The audit log: monitor edits, origins disabled, pool `minimum_origins` raised.
4. From the local machine, the monitor's request against one origin (only with the origin address from the pool; use the monitor's Host header):
   ```
   curl -sv --resolve app.example.com:443:192.0.2.10 https://app.example.com/health -o /dev/null
   ```

## Hypotheses

1. **The monitor checks the wrong thing.** Confirm: `failure_reason` names a response code or body mismatch; the curl with the monitor's path and Host returns another code than `expected_codes` (a redirect, a 401, a 404 on `path`), or `expected_body` is missing. Reject: the curl returns the expected code and body.
2. **The origins block the health checks.** Confirm: `failure_reason` is a timeout or connection refused for every origin, while the origins serve users; the origin firewall allows only some Cloudflare ranges or rate limits the monitor. Reject: health checks reach the origin (origin access log).
3. **The pool cannot meet `minimum_origins`.** Confirm: fewer origins are `enabled` and healthy than `minimum_origins`, so the pool is critical even though some origins work. Reject: enough origins are healthy.
4. **The origins are really down.** Confirm: the curl fails too and the user's monitoring agrees. Reject: the origins answer.
5. **TLS to the origin fails.** Confirm: an HTTPS monitor and `failure_reason` names a certificate or handshake error; `allow_insecure` is false with a self-signed origin certificate. Reject: TLS works.

## Fix

- Hypotheses 1 and 5: an account plan PUT of the monitor with the right `path`, `expected_codes`, `header.Host` or `allow_insecure` (cf-load-balancing, Applying changes).
- Hypothesis 2: steps for the user to allow every range from https://www.cloudflare.com/ips/ on the origin firewall for the monitor's port.
- Hypothesis 3: a pool PUT with a lower `minimum_origins` or the working origins enabled. An update that leaves zero enabled origins gets a `Lockout risk:` line; so does a load balancer whose only pool previews critical (an advisory line from the pool `preview`, shown after apply as `advisory_lockout`).
- Hypothesis 4: origin steps for the user; meanwhile a `fallback_pool` that is healthy keeps the hostname up (finding `lb.fallback.missing`).
- Verify: the pool health read shows `healthy` for the pool; a pool or monitor change can carry `"verify": { "expect": "pool_healthy" }`, which waits up to 60 seconds for `Healthy`.

## Sources

- https://developers.cloudflare.com/load-balancing/understand-basics/health-details/
- https://developers.cloudflare.com/load-balancing/monitors/
- https://developers.cloudflare.com/load-balancing/troubleshooting/load-balancing-faq/
- https://developers.cloudflare.com/load-balancing/pools/create-pool/
