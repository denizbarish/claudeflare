---
name: cf-tunnel
description: Cloudflare Tunnel checklist for one account. Remote-managed tunnels, ingress configuration, connectors and their tokens, DNS CNAMEs to cfargotunnel.com, private network routes and virtual networks, and how to run cloudflared with Docker Compose, systemd or Kubernetes. Load it when exposing a local service, auditing tunnels, changing a tunnel config, or deleting a tunnel. Load cf-core first.
---

# cf-tunnel: tunnels, ingress, connectors, routes

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Tunnels, routes and virtual networks are account resources: plans use `"scope": "account"` and hold only REST ops (no `project_dir` needed). DNS records are zone resources, so a hostname's CNAME goes in a separate zone plan; one plan never mixes scopes. In the MCP examples below, replace `ACCOUNT_ID` (32 hex characters), `TUNNEL_ID` (a UUID) and `ZONE_ID` with real values from cf-core discovery and the reads; the guard needs literal paths.

## Read current state

| What | Source |
|---|---|
| Tunnels (`id`, `name`, `status`, `connections`, `remote_config`, `config_src`) | GET `/accounts/{account_id}/cfd_tunnel` with `is_deleted: false` |
| One tunnel | GET `/accounts/{account_id}/cfd_tunnel/{tunnel_id}` |
| Ingress configuration of a remote-managed tunnel (`config.ingress`, `version`) | GET `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` |
| Connectors (one entry per running cloudflared, `conns` per edge connection, `version`) | GET `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` |
| CNAMEs that send a hostname to a tunnel | GET `/zones/{zone_id}/dns_records` with `type: "CNAME"` and `content: "<tunnel_id>.cfargotunnel.com"`, for every zone of the account |
| Private network routes (`network`, `tunnel_id`, `virtual_network_id`) | GET `/accounts/{account_id}/teamnet/routes` with `is_deleted: false` |
| Virtual networks (`name`, `is_default_network`) | GET `/accounts/{account_id}/teamnet/virtual_networks` with `is_deleted: false` |

Status values: `inactive` (never connected), `healthy`, `degraded` (some connections down), `down` (no connector).

MCP `execute`:

```js
async () => {
  const tunnels = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel", query: { is_deleted: false } });
  const config = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel/TUNNEL_ID/configurations" });
  const connectors = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel/TUNNEL_ID/connections" });
  const cnames = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dns_records", query: { type: "CNAME", per_page: 100 } });
  return { tunnels: tunnels.result, config: config.result, connectors: connectors.result, cnames: cnames.result };
}
```

Keep the CNAMEs whose `content` ends in `.cfargotunnel.com`; the part before it is the tunnel id.

Fallback: `claudeflare get /accounts/ACCOUNT_ID/cfd_tunnel --query is_deleted=false`. Lists page with `page` and `per_page`; read every page before concluding that a CNAME or route does not exist.

Never read `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`: the guard blocks it. The token reaches an env file only through `claudeflare tunnel-token` (Applying changes).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `tunnel.status.down` | `status` is `down` (or `inactive` for a tunnel that has CNAMEs or routes). Its hostnames answer error 1033. | high | At least one connector running (`healthy`) | free |
| `tunnel.connectors.single` | `status` is `healthy` and the connections read lists exactly one connector. A restart, update or host failure takes every hostname down. | medium | Two connectors on separate hosts or replicas (same token) | free |
| `tunnel.config.no_catch_all` | The last `config.ingress` rule has a `hostname` or `path`. cloudflared refuses such a config. | high | A last rule without hostname and path, for example `{ "service": "http_status:404" }` | free |
| `tunnel.dns.stale_cname` | A CNAME's content is `<uuid>.cfargotunnel.com` and no live tunnel of the account has that id. The hostname answers error 1016. | medium | Delete the record, or point it at a live tunnel | free |
| `tunnel.config.local_managed` | `remote_config` is `false` (or `config_src` is `local`): ingress lives in a `config.yml` on the connector host. claudeflare cannot snapshot or roll back that config. | low | Migrate the tunnel to remote management in the Zero Trust dashboard | free |

Notes for findings:

- `tunnel.status.down`: the fix is on the connector host, so `fix: []`; give the run steps from "Running the connector".
- `tunnel.connectors.single`: `fix: []`. With Compose, two replicas of the template below; with Kubernetes, `replicas: 2`.
- `tunnel.config.no_catch_all`: `fix` is a config PUT with the current rules plus a catch-all (Applying changes). Keep every existing hostname rule.
- `tunnel.dns.stale_cname`: `fix` is `[{ "method": "DELETE", "path": "/zones/{zone_id}/dns_records/<record id>" }]` (a zone plan). Ask first if the hostname may be moved to another tunnel instead.
- `tunnel.config.local_managed`: `fix: []`. Migration is one way; tell the user that the `config.yml` ingress is then ignored.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's `Lockout risk:` lines and notes to the user before approval; they are part of what the user approves.

| Op | Path (under `/accounts/ACCOUNT_ID`) | Rollback |
|---|---|---|
| Create tunnel | POST `/cfd_tunnel`, body only `name` and `"config_src": "cloudflare"` | Deletes the connections, then the tunnel |
| Rename | PATCH `/cfd_tunnel/TUNNEL_ID`, body only `name` | Restores the name |
| Put ingress config | PUT `/cfd_tunnel/TUNNEL_ID/configurations`, body `{ "config": { ... } }` | Puts the previous config back |
| Drop connections | DELETE `/cfd_tunnel/TUNNEL_ID/connections` | Not reversible |
| Delete tunnel | DELETE `/cfd_tunnel/TUNNEL_ID` with `confirm_name` | Not reversible |
| Route create, update, delete | POST `/teamnet/routes`, PATCH or DELETE `/teamnet/routes/ROUTE_ID` (delete takes `confirm_name` = `network`) | Delete, restore, re-create (new id) |
| Virtual network create, update, delete | POST `/teamnet/virtual_networks`, PATCH or DELETE `/teamnet/virtual_networks/VNET_ID` (delete takes `confirm_name` = `name`) | Delete, restore, re-create (new id) |

Refused at `plan new` (`invalid_op`): `tunnel_secret` in any body (Cloudflare generates it; rotation is not an op), `config_src` other than `cloudflare`, other create or rename keys, an ingress list whose last rule is not a catch-all, a rule without `service`. Refused at preflight: a virtual network delete while routes still use it, or of the default network (`resource_in_use`). A tunnel delete needs a connections delete for the same tunnel earlier in the plan, and a config PUT and a delete of one tunnel never share a plan (`plan_conflict`).

### Expose a local service (the usual request)

Explain the steps first, then draft. Four parts, in this order:

1. Account plan: create the tunnel.

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "summary": "Create tunnel app",
  "risk": "New tunnel, no traffic until a connector runs and a CNAME points at it.",
  "slug": "tunnel-app",
  "ops": [
    { "method": "POST", "path": "/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel", "body": { "name": "app", "config_src": "cloudflare" } }
  ]
}
```

   The apply result shows the new `id`; `token` and `credentials_file` are stored as `[redacted]`.

2. Token to an env file, never to the chat:

```
claudeflare tunnel-token --account 0123456789abcdef0123456789abcdef --tunnel <tunnel id> --env-path ./cloudflared.env
```

   It writes `TUNNEL_TOKEN=<value>` with mode 0600 (other lines kept), prints only the path and warns when the file is not ignored by git. Add the file to `.gitignore` when warned. The flag is `--env-path`, not `--env-file`. Never open, print or copy the file afterwards; the guard blocks reads of it.

3. Start the connector (Running the connector) and check the tunnel shows `healthy`.

4. Account plan: put the ingress config, then a zone plan for the CNAME.

```json
{
  "method": "PUT",
  "path": "/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/configurations",
  "body": {
    "config": {
      "ingress": [
        { "hostname": "app.example.com", "service": "http://localhost:3000" },
        { "service": "http_status:404" }
      ]
    }
  }
}
```

   The plan notes name every new hostname without a CNAME. The zone plan op:

```json
{ "method": "POST", "path": "/zones/{zone_id}/dns_records", "body": { "type": "CNAME", "name": "app.example.com", "content": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.cfargotunnel.com", "proxied": true } }
```

A config PUT replaces the whole config: read the current one and keep every rule that should stay. Every hostname with a CNAME to the tunnel that no rule of the new config serves gets a `Lockout risk:` line, whether the config drops its rule or it never had one: it falls through to the catch-all and answers 404. A rule with a `path` serves only that path, not the whole host.

### Delete a tunnel

Stop cloudflared on every host first, or the connectors reconnect. Then one plan:

```json
[
  { "method": "DELETE", "path": "/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/connections" },
  { "method": "DELETE", "path": "/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "confirm_name": "app" }
]
```

The plan risk names each CNAME hostname that will answer error 1016 and each private route that stops working. Delete those CNAMEs with a zone plan afterwards. Connections can linger for minutes after the connector stops; if the delete fails with active connections, wait and apply a new plan.

### Verification

After apply claudeflare reads each changed resource back, fetches `https://<hostname>/` for each hostname of a new config that already had a CNAME to the tunnel at preflight (fails on error 1016 or 1033; a new hostname without DNS yet shows `skipped: no DNS record yet`) and, when the tunnel had connectors before, expects status `healthy` or `degraded`. A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval. A config PUT on a tunnel without a running connector fails the serving check for its existing hostnames: start the connector first. After the CNAME's zone plan, check a new hostname with `curl -sI https://<hostname>/` (no 1016 or 1033).

## Running the connector

Explain these steps by default. Write the files only when the user asks, as normal edits in their project; they change no Cloudflare state, so no plan is needed. The token never goes into a generated file: it reaches the env file only through `claudeflare tunnel-token`. If the env file is not ignored by git, warn before writing anything that references it.

Pin the image or package to a current release from github.com/cloudflare/cloudflared/releases (tags look like `2026.9.0`); never `latest`. With a remote-managed tunnel, ingress comes from the API, so the connector needs only the token. A service on the host is `http://localhost:<port>`; from a container it is the Compose service name (`http://web:3000`).

Docker Compose (`TUNNEL_TOKEN` comes from `cloudflared.env`):

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:<pinned tag>
    command: tunnel --no-autoupdate run
    env_file: ./cloudflared.env
    restart: unless-stopped
    deploy:
      replicas: 2
```

Two replicas keep the hostnames up while one restarts or the token rotates. Start it with `docker compose up -d`.

systemd (Linux host, `cloudflared` installed from the package repository):

```ini
[Unit]
Description=Cloudflare Tunnel connector
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/cloudflared/tunnel.env
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run
Restart=on-failure
RestartSec=5
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

Write the token with `--env-path` to a file the user owns, then the user moves it into place in their own terminal: `sudo install -m 600 -o root -g root cloudflared.env /etc/cloudflared/tunnel.env`, then `sudo systemctl enable --now cloudflared`. The agent does not run commands that read the env file.

Kubernetes notes:

- The user creates the Secret in their own terminal: `kubectl create secret generic cloudflared-token --from-env-file=cloudflared.env`.
- A Deployment with `replicas: 2`, image `cloudflare/cloudflared:<pinned tag>`, args `["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]`, env `TUNNEL_TOKEN` from `secretKeyRef` (name `cloudflared-token`, key `TUNNEL_TOKEN`).
- Liveness probe: HTTP GET `/ready` on port 2000. Services are reached by their cluster DNS name (`http://web.default.svc.cluster.local:80`).

macOS and Windows services: `cloudflared service install <token>` takes the token on the command line, which the guard blocks here. The user runs it in their own terminal with the token shown on the tunnel's connector install page in the Zero Trust dashboard, and never pastes it into the chat. Newer cloudflared versions accept `--token-file <path>`; check `cloudflared tunnel run --help` before relying on it.

Token rotation, in order: rotate the secret in the dashboard (no claudeflare op in v3), run `claudeflare tunnel-token` again, restart the connectors, then an approved plan with `DELETE /cfd_tunnel/TUNNEL_ID/connections` to drop stale connections.

## Traps

- Re-creating a tunnel gives a new UUID, a new CNAME target and a new token. Every connector must be reinstalled and every CNAME repointed.
- A hostname needs both an ingress rule and a proxied CNAME in a zone of the same account. Rule without CNAME: no traffic. CNAME without rule: the catch-all answers (usually 404). CNAME to a deleted tunnel: 1016. No connector: 1033.
- Ingress rules match top down; a broad rule (`*.example.com`) above a specific one hides it.
- `config_src: "local"` tunnels read `config.yml` on the host; a config PUT does not reach them until the tunnel is migrated.
- A virtual network with routes cannot be deleted, and the default network cannot be deleted at all. Delete or move its routes in an earlier op of the same plan.
- Private network routes need WARP clients enrolled in the same account; a route alone exposes nothing to the internet.
- `cloudflared` with `--token <value>` on a command line puts the token in shell history and the transcript; the guard blocks it. Use `TUNNEL_TOKEN` from the environment.

## Sources

- Cloudflare Tunnel API: developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/
- Remote-managed tunnels and ingress rules: developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/
- Run parameters and `TUNNEL_TOKEN`: developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/run-parameters/
- Tunnel status and errors 1016, 1033: developers.cloudflare.com/cloudflare-one/connections/connect-networks/troubleshoot-tunnels/
- Private networks, routes and virtual networks: developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/
