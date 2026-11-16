---
name: deckhand-endpoint
description: Step 4 of setting up Deckhand. Gives Deckhand a stable public HTTPS address that GitHub can reach (Tailscale Funnel, a cloudflared named tunnel, an ngrok static domain, or the user's own URL behind a reverse proxy) forwarding to edge's port 8080, or none at all (pull mode, where Deckhand reads GitHub's deliveries itself), and sets public_url. Use alone to check or change Deckhand's public address.
---

# Deckhand: the public address

GitHub sends its webhooks to edge, and its sign-in sends browsers back there: Deckhand needs
an HTTPS address GitHub can reach, forwarding to edge's port (8080, or `PORT`), that **stays
the same** for as long as the App lives (the App is created with it, and GitHub's API can't
change its callback). Or none at all: in **pull mode**, edge reads GitHub's deliveries through
the App's API, 10 to 15 seconds slower, with no inbound connection
(`docs/guides/tunnels.md#no-public-address-pull-mode`). The reference, which has every command:
`docs/guides/tunnels.md` (or https://bryansmee.github.io/deckhand/guides/tunnels).

Run from the Deckhand folder. The helper, for the tunnels' tokens:

```sh
sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check <NAME>...
```

Write it out in full in each command: the shell keeps no variable from one command to the
next.

A tunnel's token or authtoken is a secret like the agent's: the user sets it in their own
terminal with `sh <helper's full path> set <NAME>` (never with `!` here), or types it into the
tool's own prompt. Never read it, print it, or put it in a file yourself.

## 1. What is there

- `grep -n '^public_url' server/config.yaml`, and `sh ${CLAUDE_SKILL_DIR}/../../scripts/deckhand-env check PUBLIC_URL` (`.env`'s wins when
  set; ask the user its value, it isn't secret).
- When Deckhand runs and an address is set: `curl -fsS --max-time 10 <address>/health` answers
  `ok` through the internet. Then the step is done. A local `http://` address (`localhost`, the
  machine's address on its network) is pull mode's: the step is done once it answers `ok` here.
- Already created App (edge's `curl -s localhost:8080/` doesn't say "no GitHub App yet"): the
  address is the App's. Changing it means the three places of
  `docs/guides/tunnels.md#changing-the-address`: walk the user through them, don't just change
  `public_url`.

## 2. Which address

Ask, recommending the first that fits:

1. **The user's own domain**, behind a reverse proxy (Caddy, nginx, Traefik) on a server with a
   public IP: the proxy forwards `https://<host>` to `http://<this machine>:8080`. The user
   sets the proxy up; the address is `https://<host>`.
2. **Tailscale Funnel** (recommended without a public IP: free, tested with Deckhand end to
   end): `https://<machine>.<tailnet>.ts.net`. Needs a Tailscale account, MagicDNS and HTTPS
   certificates on, and the `funnel` attribute (the default policy grants it). Follow
   `docs/guides/tunnels.md#tailscale-funnel`: `tailscale up` (the user runs it: it prints a
   sign-in link), then `tailscale funnel --bg 8080` (on Linux, `sudo` unless the user is the
   tailscale operator: the user runs it), then `tailscale funnel status` gives the address.
3. **A cloudflared named tunnel**: needs a domain on Cloudflare. `docs/guides/tunnels.md#a-cloudflared-named-tunnel`.
   With a dashboard-managed tunnel, its token goes in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`
   through the helper, and the `compose.override.yaml` the page gives runs it beside Deckhand.
4. **An ngrok static domain**: free, one per account, a warning page in browsers.
   `docs/guides/tunnels.md#an-ngrok-static-domain`, its authtoken in `.env` as
   `NGROK_AUTHTOKEN` through the helper, and the page's `compose.override.yaml`.

5. **No public address: pull mode** (recommended to try Deckhand on a laptop, or when the user
   wants no tunnel and no account beyond GitHub's): nothing to set up but the address the user
   opens Deckhand at, `http://localhost:8080` (or `http://<this machine's address>:8080` from
   another machine of their network). Say what it costs: replies start 10 to 15 seconds after
   a comment, about 300 App calls an hour, and screenshots that runs post in their comments
   don't show on GitHub. The App's webhook goes to `https://deckhand.invalid/webhook`, which
   never answers, and must stay _Active_. Moving to a tunnel later means the three places of
   `docs/guides/tunnels.md#changing-the-address`, and `DELIVERIES=webhook` in `.env`.

Never a quick tunnel (`cloudflared tunnel --url`, ngrok's random domains, localtunnel): a new
address at each start breaks the App (`docs/guides/tunnels.md#why-not-a-quick-tunnel`).

The tunnel must run again after a reboot: Tailscale's `--bg` and the services of
`compose.override.yaml` (with `restart: unless-stopped`) do; a `cloudflared` on the host needs
`sudo cloudflared service install`. Write `compose.override.yaml` with the file tools (it holds
`${…}` references, no secret), from the page's block, and show it.

## 3. `public_url`

Set `public_url: https://<address>` (no trailing `/`; pull mode's: `http://localhost:8080`, or
the one the user opens) in `server/config.yaml`; `/setup` would
otherwise guess it from the headers the tunnel passes on. When `.env` sets `PUBLIC_URL` too, it
wins: ask the user to empty that line or set it to the same address.

## 4. Check

Pull mode: nothing to check from outside; step 5 checks `<public_url>/health` here once edge
runs.

Before Deckhand runs, the address answers with the tunnel's own error (502, 530, "offline"):
that's expected, step 5 (`deckhand-launch`) checks it again. Once edge runs:

```sh
curl -fsS --max-time 10 https://<address>/health   # ok
```

A new Tailscale name can take a few minutes to resolve. Anything but `ok` once edge answers on
`curl -fsS localhost:8080/health`: the tunnel doesn't reach edge's port; see the tunnel's own
status (`tailscale funnel status`, `cloudflared tunnel info deckhand`,
`docker compose logs ngrok`).
