# Deploying to a real server (AWS EC2 or any VPS)

This automates everything that happens **on the server itself** —
installing Docker, pulling the code, generating a real `.env`, starting
the stack, and (optionally) setting up a domain with automatic HTTPS.

**What this can NOT automate, and why**: getting you an actual running
server, and pointing a domain at it, both require your own cloud/DNS
account (AWS, Cloudflare, wherever your domain is registered) — nobody
but you can click those buttons or holds those credentials, and handing
me AWS keys to do it on your behalf isn't something this project does.
The one-time steps below are exactly that boundary: a normal AWS
console walkthrough, no different from setting up any other EC2-hosted
app.

## 1. One-time setup in your cloud provider's console (you do this part)

Using AWS EC2 as the concrete example — any other VPS (Lightsail,
DigitalOcean, Linode, a bare server) needs the equivalent of the same
three things:

1. **Launch an instance.** Ubuntu 22.04 or 24.04 LTS, `t3.small` or
   larger (this app runs 5 containers including Postgres and a bundled
   Ollama — `t3.micro`'s 1GB RAM will struggle). Attach at least 20GB of
   disk if you plan to pull local LLM models via the bundled Ollama.
2. **Open the right ports in its security group** — inbound:
   - `22` (SSH) — restrict to your own IP if you can.
   - `80` and `443` — only needed if you're using `--domain` (see below).
   - `3000`, `8000`, `8100` — only if you're **not** using `--domain`
     (plain-IP mode publishes these directly). Skip these entirely once
     you're using a domain — `deploy/setup-server.sh` deliberately
     rebinds them to the server's own loopback interface in that mode
     (`BIND_HOST=127.0.0.1`, see `docker-compose.yml`), so opening them
     in the security group at that point wouldn't even reach anything.
3. **Allocate an Elastic IP and associate it with the instance** (AWS
   calls a plain EC2 public IP "ephemeral" — it changes if the instance
   ever stops/starts). Skip this for plain-IP-only testing you don't
   care about surviving a reboot; do it before pointing any real domain
   at the server, or the domain breaks the next time AWS reassigns the
   instance's IP.
4. **If using a domain**: create an `A` record for it (or a subdomain,
   e.g. `app.yourdomain.com`) pointing at that Elastic IP, in whatever
   DNS provider manages the domain. Let's Encrypt (below) needs this to
   already resolve before it can issue a certificate — DNS propagation
   can take a few minutes to a few hours.

## 2. Run the actual deploy script (this is what's automated)

SSH into the instance, then:

```bash
# Plain HTTP, reachable at the server's own public IP:
curl -fsSL https://raw.githubusercontent.com/GarfieldFan/AI-agent-mvp/master/deploy/setup-server.sh | sudo bash

# With a real domain + automatic HTTPS:
curl -fsSL https://raw.githubusercontent.com/GarfieldFan/AI-agent-mvp/master/deploy/setup-server.sh -o setup-server.sh
sudo bash setup-server.sh --domain app.yourdomain.com --email you@yourdomain.com
```

(Piping straight into `sudo bash` skips saving `--domain`/`--email`
flags anywhere to re-run later — the two-step form above, or just
`git clone` the repo yourself and run `sudo ./deploy/setup-server.sh
...` from inside it, both work identically and are easier to re-run.)

**If this repository is private**, the script's own `git clone` step
will fail with no credentials to authenticate with — either make it
public, pass `--repo` with a URL that embeds a personal access token
(`https://<token>@github.com/...`), add a deploy key to the server
first, or skip cloning entirely: upload/`git clone` the code yourself
first, then run `sudo ./deploy/setup-server.sh` from inside that
checkout (the script detects it's already inside one and uses it
in place, instead of cloning).

What the script actually does, in order — see `deploy/setup-server.sh`'s
own comments for the full detail on any one step:

1. Installs Docker Engine + the Compose plugin (official apt repo).
2. Clones (or updates) this repo.
3. Creates `.env` from `.env.example` if it doesn't exist yet — never
   overwrites one you've already customized. Generates a real random
   `JWT_SECRET` if it's still the published insecure placeholder.
4. With `--domain`: sets `PUBLIC_ORIGIN`/`PUBLIC_OWNER_AGENT_URL`/
   `BIND_HOST` in `.env` so every browser-facing URL in
   `docker-compose.yml` resolves to your domain instead of a bare
   `HOST:PORT` — see that file's own comments on those three variables.
5. `docker compose up -d --build` — migrations run automatically on
   backend startup (`backend/migrate.py`), no separate step needed.
6. Creates **one real owner account with a freshly generated random
   password**, printed once at the end of the run — this is deliberately
   NOT `backend/seed.py`'s well-known demo accounts (`owner@example.com`
   / `0000`), which exist for the local docker-compose demo only and
   would be a real, immediately-exploitable vulnerability if seeded onto
   a public server. See `backend/create_owner.py`'s own docstring.
7. With `--domain`: installs Nginx + Certbot, sets up the reverse-proxy
   config (`deploy/nginx.conf.template`), and requests a real Let's
   Encrypt certificate. If DNS hasn't propagated yet, this step fails
   loudly but non-fatally — the site is still reachable over plain HTTP
   in the meantime, and the script tells you the exact `certbot` command
   to re-run once DNS catches up.

**Safe to re-run** — every step is written to be idempotent: it won't
re-clobber your `.env`, won't create a second owner account, and reuses
an already-issued certificate.

## 3. Afterward

- **Log in** with the owner email/password printed at the end of the
  run (not shown again — if you lost it, see `backend/create_owner.py`'s
  own docstring for how to reset it directly, or use the Dashboard's own
  "Users & access" panel from another owner account to create a new one).
- **Updating to newer code**: `sudo ./deploy/update.sh` from inside the
  deployed checkout — pulls the latest commit and rebuilds/restarts.
- **No automatic backups exist.** At minimum, `docker compose exec -T
  postgres-db pg_dump -U my_user my_mvp_db > backup.sql` on whatever
  schedule matters to you, or snapshot the whole server's disk through
  your cloud provider. This app has no built-in backup/restore tooling.
- **A bundled local LLM (Ollama) works the same way it does locally** —
  connect one via the Dashboard's Model settings (or `/setup`) exactly
  as documented in the root `AGENTS.md`'s "Bundled Ollama" section.
  CPU-only by default; expect it to be slow on a small instance without
  a GPU.
- **ComfyUI (image generation) is not part of this deployment** — this
  script doesn't set up a GPU worker. Image generation reports as
  unreachable until you point `image_comfyui_url` (Model settings) at a
  real ComfyUI instance somewhere, the same "swappable, not hardcoded"
  provider design already documented in the root `AGENTS.md`.
