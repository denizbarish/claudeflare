# Tunnel 502 Bad Gateway

Symptom: a tunnel hostname answers 502 (a Cloudflare page or a plain `Bad Gateway`). The tunnel is connected, but `cloudflared` could not get a response from the service its ingress rule names.

## Evidence

1. Tunnel status and the ingress config (SKILL.md, Shared evidence). Find the rule that matches the hostname and path (rules match top down; the last rule is the catch-all) and record its `service` and `originRequest` (`noTLSVerify`, `originServerName`, `httpHostHeader`, `connectTimeout`).
2. The connector log on the host (user runs it): `docker compose logs --tail 50 cloudflared` or `journalctl -u cloudflared -n 50`. Look for `connection refused`, `no such host`, `x509: certificate`, `context deadline exceeded`, `EOF`.
3. From the connector host (user runs it, not you), the exact service URL from the rule:
   ```
   curl -sv http://localhost:3000/ -o /dev/null
   ```
   Inside Docker, run it in the `cloudflared` container's network, not on the host.

## Hypotheses

1. **The service is not listening where the rule says.** Confirm: `connection refused` in the log, and the curl from the connector host fails on that port. Reject: the curl answers.
2. **`localhost` inside a container.** Confirm: `cloudflared` runs in Docker and the rule says `http://localhost:PORT`, which is the container itself; the app runs on the host or in another container. Reject: `cloudflared` runs on the host, or the rule names the service by its Compose name.
3. **TLS mismatch to the origin.** Confirm: the rule says `https://` to a service with a self-signed or mismatched certificate (`x509` in the log), or `http://` to a port that speaks TLS. Reject: scheme and certificate fit.
4. **The origin is slow or drops the connection.** Confirm: `context deadline exceeded` or `EOF`, the app's own logs show crashes or long requests. Reject: the origin answers fast from the connector host.
5. **The wrong rule matches.** Confirm: an earlier rule with a broader `hostname` or `path` (or a wildcard) sends the request to another service. Reject: the intended rule is the first match.

## Fix

- Hypotheses 1 and 4: steps for the user on the origin (start the app, bind it to the right interface and port, fix the crash).
- Hypothesis 2: an account plan PUT of the tunnel config with the service reachable from the container (the Compose service name, or `http://host.docker.internal:PORT`), keeping every other rule (cf-tunnel, Applying changes). A config that stops serving a hostname with a CNAME shows a `Lockout risk:` line at `plan new`.
- Hypothesis 3: a config PUT with the right scheme, or `originRequest.originServerName` for the certificate's name; `noTLSVerify: true` only for a self-signed certificate on a trusted network, and say so in the plan risk.
- Hypothesis 5: a config PUT that reorders the rules, most specific first.
- Verify: `curl -sI https://app.example.com/` returns the app's status; the config PUT carries `"verify": { "expect": "tunnel_serving", "url": "https://app.example.com/" }`, which checks for 1016 and 1033 only, so also check the status code.

## Sources

- https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/origin-configuration/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/ingress/
