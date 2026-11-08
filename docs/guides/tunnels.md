# A tunnel when the server has no public address

GitHub sends its webhooks to edge, and GitHub's sign-in sends browsers back to it: Deckhand
needs an HTTPS address that GitHub can reach, forwarding to edge's port (8080). A server behind
a reverse proxy has one. A home server or a laptop behind a router usually doesn't: a tunnel
gives it one, without opening a port.

The tunnel must keep **the same address** for as long as the App lives. Three of them do, each
on a free plan:

| Tunnel                                                    | Address                      | Needs                                      |
| --------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| [Tailscale Funnel](#tailscale-funnel)                     | `<machine>.<tailnet>.ts.net` | a Tailscale account                        |
| [A cloudflared named tunnel](#a-cloudflared-named-tunnel) | a hostname of your domain    | a Cloudflare account, and a domain on it   |
| [An ngrok static domain](#an-ngrok-static-domain)         | `<name>.ngrok-free.dev`      | an ngrok account (one static domain, free) |

Whichever you pick:

- **Set `PUBLIC_URL`** in `.env` to the tunnel's address (`https://…`, no trailing `/`), then
  `docker compose up -d`. `/setup` would otherwise guess it from the headers the tunnel passes
  on, and a tunnel that rewrites `Host` would give the App the wrong one.
- **Open the setup link through the tunnel** (`https://<address>/setup?token=…`), as in
  [Create the GitHub App](github-app.md): the App's webhook URL is `<address>/webhook`, its
  sign-in callback `<address>/auth/callback`.
- **Keep the tunnel running beside Deckhand**, started again with the server: a service of the
  host (below), or a service of your `compose.yaml`'s in a `compose.override.yaml` (beside it,
  read by `docker compose` on its own) with `restart: unless-stopped`. Run it as a container of
  its own or on the host, never inside edge's network namespace (`network_mode: service:edge`):
  edge takes a request from its own loopback, with no forwarding header, for a local one (its
  health checks, `/status`).

## Why not a quick tunnel

A quick tunnel (`cloudflared tunnel --url …` without an account, ngrok's random domains,
localtunnel…) gets a new address at each start. The App's webhook URL, its sign-in callback
and its homepage were set at `/setup`, from the address of the day, and Deckhand doesn't move
them: GitHub's API can't change an App's callback URLs. After the tunnel's next restart,
GitHub's webhooks go nowhere and nobody can sign in until you change all three in the App's
settings by hand (see [Changing the address](#changing-the-address)).

## While the tunnel is down

GitHub doesn't retry a webhook it couldn't deliver, but edge does it for you: it reads the
App's recent deliveries at start and every 5 minutes, and asks GitHub to redeliver each one
that failed, within GitHub's 3 days ([The dashboard](dashboard.md), its Sync). Edge reads
them through the github service, not the tunnel: once the tunnel is back, a comment posted
while it was down gets its run within 5 minutes, or at once with **Sync** in the dashboard's
top bar. Runs already started go on: sandboxes reach GitHub through the egress proxy, not
through edge's address (the screenshots their comments show are served from it, though, and
show again once the tunnel is back). The dashboard, MCP clients and machines reach Deckhand
through the tunnel alone.

## Tailscale Funnel

Funnel publishes a port of a machine of your tailnet on `https://<machine>.<tailnet>.ts.net`,
with a certificate of its own. It needs, once, in the [admin console](https://login.tailscale.com/admin):
MagicDNS and HTTPS certificates on (_DNS_), and the `funnel` attribute for the machine in the
tailnet's policy file (Tailscale's default policy grants it to every member). Then, on the
server, with Tailscale 1.52 or later:

```sh
tailscale up
# Publishes https://<machine>.<tailnet>.ts.net (port 443) to edge's port, in the background:
# tailscaled keeps it, across reboots too.
tailscale funnel --bg 8080
tailscale funnel status   # "Funnel on", and the address
```

`PUBLIC_URL` is that address, `https://<machine>.<tailnet>.ts.net`. Public ports are 443,
8443 and 10000 only (`--https=8443`): leave it on 443. `tailscale funnel reset` turns it off.
A new DNS name can take a few minutes to resolve from GitHub's side the first time.

## A cloudflared named tunnel

A named tunnel keeps its hostname, one of a domain whose DNS is on Cloudflare
(`deckhand.example.com` below). On the server, with `cloudflared` installed:

```sh
cloudflared tunnel login                        # once: picks the domain, writes cert.pem
cloudflared tunnel create deckhand              # the tunnel and its credentials (~/.cloudflared/<id>.json)
cloudflared tunnel route dns deckhand deckhand.example.com   # the CNAME to the tunnel
```

Then `~/.cloudflared/config.yml`, sending that hostname to edge, and nothing else:

```yaml
tunnel: deckhand
credentials-file: /home/<you>/.cloudflared/<id>.json
ingress:
  - hostname: deckhand.example.com
    service: http://localhost:8080
  - service: http_status:404
```

`cloudflared tunnel run deckhand` checks it; `sudo cloudflared service install` keeps it
running as a service of the host (it reads its config from `/etc/cloudflared/`: copy the
config and the credentials there, the path in `credentials-file` with them). `PUBLIC_URL` is
`https://deckhand.example.com`.

A tunnel managed from Cloudflare's dashboard (_Zero Trust_, _Networks_, _Tunnels_) works the
same, and runs as a service of your Compose project: give it the public hostname
`deckhand.example.com` sending to `http://edge:8080`, put its token in `.env`
(`CLOUDFLARE_TUNNEL_TOKEN`), and in `compose.override.yaml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    # Edge's own way in and out: the tunnel reaches it as edge:8080.
    networks: [edge-out]
```

## An ngrok static domain

Each ngrok account has one static domain, free (`<name>.ngrok-free.dev`, or
`.ngrok-free.app` for older accounts), on its dashboard's _Domains_. On the server, with
`ngrok` installed and your account's authtoken:

```sh
ngrok config add-authtoken <token>
ngrok http 8080 --url https://<name>.ngrok-free.dev
```

`PUBLIC_URL` is `https://<name>.ngrok-free.dev`. To keep it running, a service of your Compose
project, its authtoken in `.env` (`NGROK_AUTHTOKEN`), in `compose.override.yaml`:

```yaml
services:
  ngrok:
    image: ngrok/ngrok:latest
    restart: unless-stopped
    command: http edge:8080 --url https://<name>.ngrok-free.dev
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
    # Edge's own way in and out: the tunnel reaches it as edge:8080.
    networks: [edge-out]
```

On the free plan, ngrok shows browsers a warning page before the site, once per browser:
click through it for `/setup` and the dashboard. GitHub's webhooks don't get it.

## Changing the address

Moving to another address (another tunnel, a domain of your own) means changing it in three
places, as the App keeps the one it was created with:

1. `PUBLIC_URL` in `.env`, then `docker compose up -d`.
2. The App's settings on GitHub (_General_): **Homepage URL** `<address>`, **Callback URL**
   `<address>/auth/callback`, and under _Webhook_, **Webhook URL** `<address>/webhook`.
3. [MCP clients](mcp-clients.md) and [machines](machines.md) set up with the old address:
   point them at the new one.

Deliveries sent to the old address meanwhile are asked again by edge, as
[while the tunnel is down](#while-the-tunnel-is-down).
