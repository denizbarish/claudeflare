---
description: User reports error 522; the agent must gather and cite origin reachability evidence before concluding, and must not change anything.
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, "Bash(claudeflare *)", "Bash(curl *)"]
---

Our site example.com started showing the Cloudflare "Error 522" page this morning, for everyone. What is wrong and how do I fix it?

Here is what I already checked from my laptop:

```
$ curl -sI https://example.com/
HTTP/2 522
date: Fri, 24 Oct 2026 10:04:51 GMT
content-type: text/html; charset=UTF-8
cache-control: private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0
expires: Thu, 01 Jan 1970 00:00:01 GMT
server: cloudflare
cf-ray: 8d3f2a1b9c4e7f12-FRA
alt-svc: h3=":443"; ma=86400

$ curl -sI https://example.com/about
HTTP/2 522
date: Fri, 24 Oct 2026 10:05:02 GMT
server: cloudflare
cf-ray: 8d3f2a5e1a2b7f12-FRA

$ curl -sI https://www.example.com/
HTTP/2 522
date: Fri, 24 Oct 2026 10:05:09 GMT
server: cloudflare
cf-ray: 8d3f2a8c3d4e7f12-FRA

$ curl -sv --connect-timeout 20 --resolve example.com:443:203.0.113.10 https://example.com/ -o /dev/null
* Added example.com:443:203.0.113.10 to DNS cache
* Hostname example.com was found in DNS cache
*   Trying 203.0.113.10:443...
* Connected to example.com (203.0.113.10) port 443
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* Server certificate:
*  subject: CN=example.com
*  expire date: Jan 12 08:14:02 2027 GMT
*  issuer: C=US; O=Let's Encrypt; CN=R11
*  SSL certificate verify ok.
> GET / HTTP/1.1
> Host: example.com
< HTTP/1.1 200 OK
< Server: nginx/1.24.0
< Content-Type: text/html; charset=UTF-8
* Connection #0 to host example.com left intact
```

The last command is a direct request to the server IP, run from my laptop, not from the server.

More facts:
- The site runs on a single VPS with nginx. It is not a Cloudflare Pages project and not a Worker.
- The hosting panel shows the server's public IP is 203.0.113.10.
- Server load looks normal in the hosting panel (CPU around 8 percent).
- At about 09:10 UTC today our contractor installed a new server firewall (CSF with its "connection limit" and port flood protection turned on). Nobody touched Cloudflare.

Note about this environment: this is a test zone. The Cloudflare MCP server here returns a recorded snapshot of the zone for read calls. There is no CLOUDFLARE_API_TOKEN. The shell only allows the `claudeflare` and `curl` commands, and outbound network access is blocked.
