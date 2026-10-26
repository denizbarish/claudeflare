# Tunnel error 1033: Argo Tunnel error

Symptom: a tunnel hostname answers HTTP 530 with error 1033. The CNAME points at a tunnel of this account, but Cloudflare cannot reach any connector of that tunnel: no `cloudflared` is connected.

## Evidence

1. Tunnel, connectors and config (SKILL.md, Shared evidence). Record `status` (`inactive`, `down`, `degraded`, `healthy`), `conns_inactive_at`, each connector's `version`, `run_at` and `conns`, and the config `version`.
2. Ask the user for the connector side, run on the host (never with a token on the command line):
   ```
   docker compose ps cloudflared
   docker compose logs --tail 50 cloudflared
   systemctl status cloudflared
   journalctl -u cloudflared -n 50
   ```
   Look for `Unauthorized: Invalid tunnel secret`, `failed to dial to edge`, `TLS handshake timeout`, a crash loop, or a stopped service.
3. The audit log: a tunnel delete of connections, a token rotation in the dashboard, or a tunnel rename does not stop connectors; a rotation does.

## Hypotheses

1. **No connector runs.** Confirm: `status` is `down` or `inactive`, the connections read is empty, and the service or container is stopped or crash looping. Reject: a connector is listed with recent `run_at`.
2. **The connector uses an old or wrong token.** Confirm: the log shows `Unauthorized` or the token belongs to another tunnel (the tunnel id in the log differs from the CNAME UUID); the tunnel was rotated or re-created. Reject: the log shows registered connections for this tunnel id.
3. **The host cannot reach Cloudflare.** Confirm: logs show dial or TLS timeouts to the edge; the host's firewall blocks outbound port 7844 (TCP and UDP for QUIC). Reject: the host connects.
4. **The CNAME points at a different tunnel than the one with connectors.** Confirm: the user runs connectors for tunnel A, the CNAME names tunnel B (both live). Reject: the UUIDs match.
5. **Connections were dropped on purpose.** Confirm: an applied plan with `DELETE /cfd_tunnel/TUNNEL_ID/connections` ran while the connectors were stopped, and nobody restarted them. Reject: no such plan.

## Fix

- Hypothesis 1: steps for the user to start the connector (cf-tunnel, Running the connector). Suggest two replicas so one restart does not take the hostname down (finding `tunnel.connectors.single`).
- Hypothesis 2: refresh the token into the env file with `claudeflare tunnel-token --account ACCOUNT_ID --tunnel TUNNEL_ID --env-path ./cloudflared.env` (never print it), then the user restarts the connector. The flag is `--env-path`.
- Hypothesis 3: the user allows outbound TCP and UDP 7844 to Cloudflare, or sets `--protocol http2` when UDP is blocked.
- Hypothesis 4: a zone plan repointing the CNAME (cf-dns), or the user runs the connector for the right tunnel.
- Hypothesis 5: the user restarts the connectors.
- Verify: the tunnel reads `healthy` with at least one connector, and `curl -sI` on the hostname returns the app's status without 530.

## Sources

- https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/
