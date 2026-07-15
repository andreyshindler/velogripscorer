# Deploying VeloGripScorer on a VPS

Everything runs in Docker: the Node app (SQLite + uploads in a persistent
volume) behind Caddy, which handles HTTPS automatically.

## 1. One-time VPS setup (Ubuntu/Debian)

```bash
# install Docker (includes the compose plugin)
curl -fsSL https://get.docker.com | sh

# open the firewall if you use ufw
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 2. Get the code and configure

```bash
git clone https://github.com/andreyshindler/velogripscorer.git
cd velogripscorer

cp .env.example .env
nano .env
```

Set in `.env`:

- `JWT_SECRET` — run `openssl rand -hex 32` and paste the output.
- `ADMIN_PASSWORD` — a strong password for the built-in admin account.
- `DOMAIN` — *optional.* If you have a domain, create a DNS **A record**
  (e.g. `scores.yourdomain.com` → your VPS IP) and put that hostname here;
  Caddy will obtain a Let's Encrypt certificate automatically. Leave empty
  to test over plain HTTP first (`http://YOUR-VPS-IP`).

## 3. Launch

**Behind an existing nginx/Apache** (the default — the app publishes on
127.0.0.1:3000 only):

```bash
docker compose up -d --build
docker compose logs -f app    # Ctrl-C to stop watching
```

Then add the `location` block from [`deploy/nginx-veloscorer.conf`](deploy/nginx-veloscorer.conf)
to your existing HTTPS `server { ... }` and `sudo nginx -t && sudo systemctl reload nginx`.

**Fresh VPS with no web server** — start the bundled Caddy proxy too
(automatic HTTPS when `DOMAIN` is set in `.env`):

```bash
docker compose --profile caddy up -d --build
```

Open `https://scores.yourdomain.com` (or `http://YOUR-VPS-IP`). Log in as
`admin@velogripscorer.local` with your `ADMIN_PASSWORD`, or register a
normal account for organizing races.

> `ADMIN_PASSWORD` only **seeds** the admin account the first time the server
> boots against an empty database — it is hashed and stored in the DB, not read
> on every start. Editing `.env` afterward has no effect. To change the password
> later, log in and use **My profile → Change password** in the web app.

**Android app**: in Settings set *Server URL* to `https://scores.yourdomain.com`
(or `http://YOUR-VPS-IP`), paste a reader token from your contest's Timing
tab, then *Test server connection*.

## 4. Updating to a new version

```bash
cd velogripscorer
git pull
docker compose up -d --build
```

The database and uploads live in the `vgs_data` volume and survive rebuilds.

## 5. Backups

Everything worth keeping is one SQLite file plus the uploads directory:

```bash
# nightly backup at 03:30 into /root/backups (add with: crontab -e)
30 3 * * * docker compose -f /root/velogripscorer/docker-compose.yml exec -T app \
  sh -c 'cp /data/velogripscorer.db /data/backup.db' && \
  docker cp $(docker compose -f /root/velogripscorer/docker-compose.yml ps -q app):/data/backup.db \
  /root/backups/velogripscorer-$(date +\%F).db
```

Restore = stop the stack, copy a backup over `/data/velogripscorer.db` in
the volume, start again.

## Notes

- The app itself listens only inside the Docker network; Caddy is the sole
  public entry point (ports 80/443).
- SQLite comfortably handles club/event-scale traffic. If you outgrow it,
  `server/db.js` is the single seam to swap for PostgreSQL.
- Health probe for uptime monitors: `GET /api/health`.

## Telegram start-list bot (optional)

To manage a race's start list from Telegram (add / edit / delete racers,
export the CSV), set two vars in `.env` and rebuild:

```
TELEGRAM_BOT_TOKEN=123456:ABC...        # from @BotFather
TELEGRAM_ALLOWED_USER_IDS=              # leave empty for the first boot
```

```bash
docker compose up -d --build
docker compose logs app | grep -i telegram   # "bot started (long polling)"
```

Message your bot to learn your numeric Telegram id (e.g. via
[@userinfobot](https://t.me/userinfobot)), put it in
`TELEGRAM_ALLOWED_USER_IDS` (comma-separated for several people), and rebuild
again. The bot answers only those ids and ignores everyone else — and everyone
while the list is empty. Then send it `/races` to pick a race and `/help` for
the commands. It needs only outbound access to `api.telegram.org` (long
polling), so it works behind the reverse proxy and the `BASE_PATH` prefix with
no extra ports or webhook URL.

## Auto-deploy on merge to `main` (self-hosted runner)

`.github/workflows/deploy.yml` redeploys the VPS on every push to `main`. It runs
on a **self-hosted GitHub Actions runner installed on the VPS**, so GitHub never
needs SSH access — the runner pulls jobs over an outbound HTTPS connection and
runs the deploy commands locally.

One-time setup on the VPS (run as the same user that owns the clone and can use
Docker, e.g. `komodo`):

```bash
# 1. Get a registration token: repo → Settings → Actions → Runners →
#    "New self-hosted runner" (Linux x64). Copy the token it shows.

# 2. Install the runner (versions/URL from that page):
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/andreyshindler/velogripscorer --token <TOKEN>

# 3. Run it as a service so it survives reboots:
sudo ./svc.sh install
sudo ./svc.sh start
```

The deploy job `cd`s into `~/projects/velogripscorer` by default; if the clone
lives elsewhere, set a repo **Variable** `DEPLOY_DIR` (Settings → Secrets and
variables → Actions → Variables) to the absolute path. The runner user must be
able to run `docker` (add it to the `docker` group: `sudo usermod -aG docker
$USER`, then re-login). `.env` is untracked, so the `git reset --hard` in the
job preserves it and the `vgs_data` volume.

To deploy on demand without a push, use **Actions → Deploy to VPS → Run
workflow**.

## Serving under a path prefix

To host the app at `https://your-host/veloscorer` instead of the domain root
(e.g. the VPS hostname already serves something else), set in `.env`:

```
BASE_PATH=/veloscorer
```

and rebuild (`docker compose up -d --build`). All pages, API routes and the
Android sync endpoints then live under the prefix — set the app's *Server URL*
to `https://your-host/veloscorer`. With an existing nginx, use the snippet in
[`deploy/nginx-veloscorer.conf`](deploy/nginx-veloscorer.conf) — it keeps the
prefix on both sides and disables buffering for the live SSE streams.
