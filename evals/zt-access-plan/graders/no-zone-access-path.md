---
type: tool_used
tool: Write
input_match: "/zones/[^\"'\\s]*/access/"
min: 0
max: 0
arm: both
---

Fails if a draft the agent wrote targets the zone form of Access (`/zones/<zone_id>/access/...`). claudeflare accepts Access writes only on `/accounts/<account_id>/access/...`.
