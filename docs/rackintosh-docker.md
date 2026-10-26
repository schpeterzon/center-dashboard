# rackintosh-docker deployment (2026-10-26)

The dashboard runs on rackintosh-docker as Portainer stack **68**, `center-dashboard`, on
endpoint **3** (`local`). The stack is Git-backed: Portainer checks out `main`, builds the
image `center-dashboard:local` from `deploy/rackintosh-docker.yml`, and runs container
`center-dashboard-dashboard-1`.

- Open it at `http://192.168.1.18:8790` (LAN) or `http://100.101.246.117:8790` (tailnet).
  It is not published through Cloudflare.
- It joins `hermes-agent_default`, so it reaches the local Harness at
  `http://local-ai-harness:8797` and JARVIS at `http://hermes:8770` by name. Both
  connections are saved in Settings, with their tokens encrypted in the data volume.
- Proxmox is read through the API token `root@pam!center-dashboard` on rackintosh, which has only
  the `PVEAuditor` role on `/`. Revoke it with `pveum user token remove root@pam center-dashboard`.
- The named volume `center-dashboard_data` holds the password, sessions, connections and
  the encryption key. Do not remove it.
- The owner password was generated at setup and is in the root-only file
  `/opt/center-dashboard/owner-password` on the host. Change it in Settings → Security.

## Updating

Push to `main`, then in Portainer open the stack and choose **Pull and redeploy** with
"Re-pull image" off: the image is built from the checkout, so there is nothing to pull, and
turning it on makes the redeploy fail. Afterwards check that
`/healthz` returns 200 and that Settings → Connections shows both connections as working.

## Verified at deployment

The container is healthy. Both connections passed their test. `/api/stream` reported the
Harness event stream as connected. A read-only task (`task_0mvolurzbje6jlgo0fp`, worker
`researcher`, risk low, local Qwen model) was created from the dashboard and completed in
36 s with no file changes. Each of its events reached the open stream about 0.1 s after
the Harness sent it. The signed-in page in a browser showed live Harness data.
