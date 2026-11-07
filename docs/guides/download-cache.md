# Download cache

Every run downloads its packages again: `apt-get`, `apk add`, `npm ci`, `pip install`, a
toolchain's archive. A repository's `caches` volumes and `docker: { cache: true }` keep
some of that for that repository only. The egress proxy can keep it for every run instead,
for the hosts you list:

```yaml
# server/grants/default.yaml (or grants/<owner>/<repo>.yaml, for one repository)
hosts: [registry.npmjs.org, files.pythonhosted.org, pypi.org]
cached_hosts: [deb.debian.org, dl-cdn.alpinelinux.org, registry.npmjs.org, files.pythonhosted.org]
```

- **Which hosts**: only the grants folder lists them, like `hosts`; a repository's
  `.deckhand.yaml` can't. A cached host must be reachable too (in `hosts`, or mandatory):
  `cached_hosts` alone opens nothing. List public mirrors whose files are the same for
  everyone, not APIs.
- **What is never kept**: a request with a body, `Cookie`, `Range` or a credential-like
  header (`Authorization`, `Private-Token`, `X-Api-Key`…), anything but a `GET` answered
  `200`, and an answer marked `Cache-Control: private` or `no-store`, or larger than `EGRESS_CACHE_ENTRY_MAX` (1 GB). Those go through as before. Cookies an answer
  sets reach that client only. Answers are kept as long as the host says they are fresh,
  then checked again with it.
- **When**: a run's cached hosts are fixed when it starts, from the grants then: a change
  applies to the next runs, not to those already running.
- **Size**: one cache for every repository, in the `egress` service's `egress-cache` volume
  (`deckhand_egress-cache` with compose's default project name), at most `EGRESS_CACHE_MAX`
  (10 GB by default): beyond it, the least recently used answers go. Set it in the `egress`
  service's `environment` ([Advanced settings](../settings.md#advanced-settings)); `0` turns the cache off.
- **HTTPS**: the proxy decrypts the HTTPS of cached hosts, and only theirs, with a CA it
  makes on its first start and keeps in that volume (`ca/`). Each run whose grant has
  cached hosts trusts that CA (its key never leaves the volume). The agent's hosts and
  GitHub's are never decrypted, and nor are a container engine's connections, which only
  get plain HTTP cached. Removing the volume, or `ca/` in it, and restarting the proxy makes
  a new CA, which the next runs get.

What this implies (the proxy reads cached hosts' traffic, and holds a key sandboxes trust),
and the rules in full: [The egress cache](../security.md#the-egress-cache) in the security
model.

To check it: `docker compose logs egress` says `cache on, HTTPS too` at start. Ask two runs
of a repository with a cached host to fetch the same file from it with a `GET` (`curl -s -o
/dev/null -D - https://<host>/<file>`; `curl -I` isn't cached): the second answer says
`x-deckhand-cache: hit`. A run whose grant has cached hosts while the proxy's cache is off
says so in its log on the dashboard (`Egress cache: off for this run`), and
reaches those hosts as before, through a tunnel.
