# 🏁 VeloGripScorer

A race-timing platform in the spirit of webscorer.com. The division of labor:

- **Web (this server)** — create races, upload start lists (CSV: bib / name /
  category / wave / chip), get the app pairing code, and publish results: the
  public watches live standings — Place, Bib, Category place, Laps, Time,
  Behind, DNS/DNF/DSQ — and browses the archive of past races.
- **Android app (`android/`)** — the timing computer at the venue: connects to
  the RFID reader over the router's LAN, starts waves at the gun, computes
  standings offline, and uploads the race to the web (live when there's
  connectivity, or with one tap afterwards).

(The community-voting contest engine from the original spec still exists at the
API level but is no longer exposed in the UI.)

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # integration test suite (node:test + supertest)
```

Deploying to a server? See **[DEPLOY.md](DEPLOY.md)** — Docker Compose with
automatic HTTPS via Caddy, persistent SQLite volume, updates and backups.

Default admin account is seeded on first boot: `admin@velogripscorer.local` /
`change-me-please` — override with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database + uploaded files |
| `JWT_SECRET` | dev value | **Set in production** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | see above | Seeded administrator |
| `TELEGRAM_BOT_TOKEN` | unset | Enables the Telegram start-list bot |
| `TELEGRAM_ALLOWED_USER_IDS` | unset | Comma-separated Telegram user ids allowed to use the bot |
| `PUBLIC_BASE_URL` | unset | Public site URL; when set, race-day reminders include a results link |
| `DISABLE_RATE_LIMIT` | unset | Disables rate limiting (tests only) |

### Telegram start-list bot

Set `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)) to manage a
race's start list from Telegram — the same add / edit / delete a racer and CSV
export the web **Manage** tab offers. The bot signs in as the admin account, so
it can manage any race.

Only allowlisted Telegram accounts are answered: put your numeric Telegram user
id(s) in `TELEGRAM_ALLOWED_USER_IDS` (comma-separated). Everyone else — and
everyone if the list is empty — is silently ignored. To find your id, start the
bot, message it `/whoami`, add the id, and restart.

Commands (also available as tap buttons — a persistent keyboard for the common
ones and the Telegram “Menu” list): `/races` (pick a race), `/list [text]`,
`/add` (guided, or one line
`/add bib=101 name=Jane Doe cat=M40 dist=10k gender=F team=Aces wave=Elite epc=…`),
`/edit <bib>` (field buttons incl. wave & chip, or `/edit 101 name=… wave=…`),
`/del <bib>`, `/csv`. A racer added without a chip gets its bib as a full
24-char EPC (`000…000101`), matching what the readers emit. The bot uses long
polling (outbound to `api.telegram.org`) — no inbound webhook or public URL is
needed, so it works behind a `BASE_PATH` reverse proxy. Under Docker, set both
vars in `.env`; `docker-compose.yml` passes them through.

**Race-day reminders.** When the bot is running it checks hourly for races
starting within the next 24 hours and sends a one-time reminder to every chat
that has talked to the bot (the allowlisted organizers), so nobody forgets to
set up timing. Set `PUBLIC_BASE_URL` to include a results link in the message.

**Runner self-service (approval-gated).** Anyone can DM the bot: it asks for
their **bib number** and **name**, records the request, and pings the allowlisted
admins with Approve / Reject buttons (showing the declared name so they can
confirm identity). Once an admin approves (and the bib is in an active
league), the runner gets a Hebrew menu — **my ranking** (their result across
every finished race), **last race** (full detail of the most recent one),
**all races** (the schedule, next race in bold), and **my team** (the full
team standings with theirs highlighted). Runners are stored in their own `runners` table (separate from the
operator sessions), so opening the bot to runners never exposes admin actions or
sends them operator-only messages. With an empty allowlist the bot stays fully
silent (no operators means nobody can approve).

**Optional second (runner) bot.** Set `TELEGRAM_RUNNER_BOT_TOKEN` to a *different*
@BotFather bot and the server runs a second poller that serves **only** the
runner flow to everyone who DMs it — approvals still happen on the operator bot.
This lets one person test the whole flow from a single account (DM the runner
bot as a runner; approve on the operator bot), and doubles as a public
runner-facing bot separate from the private operator bot. With no runner token
set, the single operator bot serves both roles exactly as before. To try it on
staging, edit `~/projects/velogripscorer-staging/.env` to set `TELEGRAM_BOT_TOKEN`
(operator), `TELEGRAM_ALLOWED_USER_IDS` (your id), and `TELEGRAM_RUNNER_BOT_TOKEN`
(runner), then `docker compose -p velogrip-staging up -d --build app`.

## Continuous integration

Two path-filtered GitHub Actions workflows so each change only runs what it
affects:

- **Web CI** (`.github/workflows/web.yml`) — runs the server + SPA tests and a
  boot smoke test on the Node 20/22 matrix whenever `server/`, `public/`,
  `test/`, or the package files change.
- **Android APK** (`.github/workflows/android.yml`) — builds the debug APK when
  `android/` changes (or via manual dispatch), uploads it as an artifact, and
  **delivers it to Telegram**. Set two repository secrets to enable delivery
  (Settings → Secrets and variables → Actions):
  - `TG_BOT_TOKEN` — a Telegram bot token (the start-list bot's token works).
  - `TG_CHAT_ID` — the chat to send to (your numeric Telegram user id for a DM).

  Without those secrets the APK still builds and uploads; the Telegram step is
  skipped. Delivery is skipped on pull requests.
- **Deploy to VPS** (`.github/workflows/deploy.yml`) — when a push to `main`
  touches web/server/Docker files (or on manual dispatch), a job runs on a
  **self-hosted runner installed on the VPS**, fast-forwards the deployment
  clone to `main`, runs `docker compose up -d --build`, and pings Telegram with
  the result. Android-only or docs-only merges don't redeploy. Only `main`
  triggers it (never pull requests), so only reviewed code deploys. Set the repo
  variable `DEPLOY_DIR` if the clone isn't at `~/projects/velogripscorer`. See
  DEPLOY.md for the one-time runner setup.
- **Deploy to Staging** (`.github/workflows/deploy-staging.yml`) — a separate
  preview stack (own clone, DB volume, port, and `/veloscorer-staging` URL) that
  redeploys from the `staging` branch, so web changes can be clicked through on
  the VPS before merging to prod. See DEPLOY.md.

## Architecture

A deliberately simple, dependency-light monolith designed so each concern can later be
extracted into its own service:

```
server/
  index.js        app assembly, security headers, static SPA hosting, admin seed,
                  background sweeper that auto-finishes ended contests
  db.js           SQLite schema (WAL mode) + immutable audit log helper
  auth.js         JWT sessions, bcrypt passwords, role guards, rate limiting
  scoring.js      weighted score: Score = Σ (weight/100 × avg criterion score)
  events.js       SSE hub (real-time leaderboards), in-app notifications,
                  HMAC-signed outbound webhooks
  telegram.js     Telegram start-list bot (add/edit/delete racers, CSV export)
  moderation.js   automated profanity screen
  routes/         users, contests, entries (+votes/comments/reports), admin
public/           vanilla-JS SPA — no build step; English + Hebrew (RTL) i18n
test/             end-to-end API tests
openapi.yaml      API specification
```

**Scoring model.** Each contest defines criteria with percentage weights that must sum
to 100. Voters score every criterion on a 0–`scale_max` scale (default 10). An entry's
final score is `Σ (weight/100 × average criterion score)`; the leaderboard also reports
`% of max`. One ballot per voter per entry — re-voting overwrites, self-votes are
rejected, and voting is rate-limited.

**Real time.** Every vote broadcasts the recomputed leaderboard over Server-Sent Events
(`GET /api/contests/:id/stream`), so open leaderboards update within a second or two.
Score history is recorded per vote and rendered as an SVG line chart.

## Feature map (requirements → implementation)

| Spec | Status | Notes |
| --- | --- | --- |
| 3.1 User management | ✅ core | Email registration/login (bcrypt + JWT), profile with bio/avatar/links, public/private toggle, reputation points, GDPR data export. Social login & 2FA are stubs for a later OAuth integration. |
| 3.2 Contest creation | ✅ | Title/description/dates/category, criteria with weight validation (must sum to 100), public/private with invite codes, open/closed voting windows, tags, participant caps, invitations by email. |
| 3.3 Submissions | ✅ | Text/Markdown, code, images (JPG/PNG/GIF/WebP), video (MP4/WebM ≤ 100 MB), PDF; instant preview in UI; per-entry description & tags; automated profanity screen holds entries for review. |
| 3.4 Voting & scoring | ✅ | Per-criterion scoring, weighted totals, blind voting (identities hidden until finish), one vote per voter per entry, rate limiting, voting windows, comments with abuse reporting, real-time updates via SSE. |
| 3.5 Leaderboards | ✅ | Rank / score / % of max / vote counts, CSV export, per-entry score-history chart, gold/silver/bronze badges on finish. |
| 3.6 Notifications | ✅ in-app | Invites, comments, wins, moderation actions, contest finished (followers). Email delivery is a pluggable next step. |
| 3.7 Search & discovery | ✅ | Full-text search over title/description/tags/organizer, category/tag/date filters, popularity sort, follow contests, tag-based recommendations. |
| 3.8 Prizes | ✅ core | Prize types (badge/points/physical/coupon/premium) per rank, automatic winner notification with redemption note. |
| 3.9 Moderation & safety | ✅ | User reports on entries/comments/users/contests, admin queue (dismiss/remove/ban), profanity filter, immutable audit log of all actions. |
| 3.10 API & integrations | ✅ | REST API (`openapi.yaml`), SSE for real-time reads, HMAC-signed webhooks for `contest.finished`, `winner.declared`, `abuse.reported`. OAuth/social login and payments are future work. |
| 3.11 Accessibility & i18n | ✅ | English + Hebrew with automatic RTL, keyboard-navigable UI, visible focus rings, ARIA labels/roles, locale-aware date formatting. |

### Non-functional notes

- **Security**: bcrypt-hashed passwords, JWT bearer auth, parameterized SQL everywhere
  (no string interpolation of user input), HTML escaping in the SPA, `nosniff`/
  `X-Frame-Options` headers, upload MIME whitelist, per-user rate limiting. TLS 1.3 is
  expected to terminate at the reverse proxy.
- **Scalability**: SQLite in WAL mode is the honest MVP choice; `scoring.js` and
  `events.js` isolate exactly the pieces that would move to PostgreSQL + Redis pub/sub
  when scaling out.
- **DevOps**: GitHub Actions CI runs the test suite on Node 20 and 22 plus a boot smoke
  test. `npm run dev` gives auto-reload locally.

## RFID race timing (Android bridge app)

The platform doubles as an RFID timing system. The `android/` directory contains
**VeloGrip RFID** — a zero-dependency Java Android app that is a **standalone timing
computer**: it connects to the RFID system's WiFi router, talks TCP to the reader on
that LAN, and runs the entire race locally — start list, gun times, live standings —
with no internet required. The web platform is a sync target, not a dependency:

```
                 [RFID reader] --LAN--> [router] --WiFi--> [VeloGrip RFID app]
                                                                │  runs the race offline
   start list  ⬇ download before the race    results ⬆ upload  │  (when connectivity exists)
                          [VeloGripScorer web platform]
```

The app's **Race** screen shows waves with local Start buttons and a live race clock,
computes standings on-device (same suppression/lap/ranking rules as the server), and
takes manual bib entries for failed chips. Every passing and gun time is stored in the
phone's SQLite database and marked-as-uploaded once the server confirms it, so results
survive dead zones and sync automatically whenever the bridge has connectivity —
during the race over cellular, or hours later from home WiFi.

### Setup

1. **Web**: open your contest → **Timing** tab → *Add reader* → copy the device token.
2. **App**: install `app-debug.apk` (built by the `Android APK` CI job — download the
   `velogrip-rfid-debug-apk` artifact from the Actions tab, or run
   `cd android && gradle assembleDebug` with the Android SDK installed).
3. In the app settings enter:
   - **Server URL** + **reader device token** (from step 1) — *Test server connection*
     verifies both.
   - **Reader IP/port** — the RFID reader's address on the router's LAN.
   - **Protocol** — `RFID-LLRP` for Impinj/Zebra-class readers (standard port 5084;
     the app performs the full LLRP handshake — DELETE/ADD/ENABLE/START ROSpec —
     puts the reader into continuous inventory, decodes EPC-96/EPCData + PeakRSSI
     from RO_ACCESS_REPORTs and answers KEEPALIVEs), `ASCII lines` for timing boxes
     that stream an EPC per line, `UHF binary frames` for the common `0xA0`-framed
     UHF reader modules (real-time inventory `cmd 0x89/0x8B`, RSSI = byte − 129),
     or `Demo mode` to test the whole pipeline with fake reads.
   - **Scan for reader(s)** — join the RFID router's WiFi and the app sweeps the
     /24 subnet probing the reader port to discover its IP automatically.
   - Optional **on-connect / poll hex commands** (e.g. to kick the reader into
     real-time inventory) and a per-tag duplicate window.
   - Optional **reader WiFi SSID/password** — on Android 10+ the app joins the RFID
     router's WiFi itself via `WifiNetworkSpecifier` *without* dropping mobile data:
     the reader socket binds to the WiFi network while uploads ride the cellular
     connection. On Android 9 or older, join the reader WiFi manually.
4. **Start bridge**. Reads are queued in a local SQLite outbox (survives offline
   stretches and restarts) and batch-uploaded every 3 s; the Timing tab shows them
   live via SSE, maps EPCs to participants/bibs, computes passings (first/last read,
   elapsed), and exports CSV.

### Race timing (waves, gun times, results)

The Timing tab is a full race console:

- **Waves & race start** — create waves (mass/wave starts), hit **Start** to record
  the gun time (millisecond precision), watch the per-wave race clock. Restarting a
  wave requires confirmation so a double-tap can't wipe times.
- **Start suppression** — reads within N seconds of the gun (default 10) are ignored,
  so racers crossing the start antenna don't get phantom finishes.
- **Race results** — live-ranked table: elapsed = last valid crossing − gun time,
  laps counted with a configurable minimum lap gap (default 30 s), fastest time first
  (more laps ranks higher for lap races), statuses `finished` / `on course` /
  `wave not started`, 0.1 s display precision, CSV export.
- **Tag assignments** carry bib, participant, category, and wave; results can be
  filtered by category (`?category=`).
- **Manual entry** — type a bib and hit Record for racers whose chip failed;
  unknown numeric bibs get a synthetic assignment automatically.

### App ⇄ web sync (all authenticated by the reader device token)

- `GET /api/ingest/startlist` — the app pulls racers (EPC/bib/name/category/wave),
  waves, and timing settings before the race.
- `POST /api/ingest/wave-start` — the app pushes locally recorded gun times; the
  server keeps an earlier gun time unless `force` is set, and creates waves that
  were born on the phone.
- `POST /api/ingest/reads` — passings batch-upload from the phone's outbox.

Reader management, ingestion, tag assignment, waves, race-results and passings
endpoints are documented in `openapi.yaml`.

## API

Interactive spec in [`openapi.yaml`](openapi.yaml). Flavor:

```bash
# register, create a contest, submit, vote, read the leaderboard
TOKEN=$(curl -s localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"password123","name":"Me"}' | jq -r .token)

curl -s localhost:3000/api/contests -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "title":"Best bike photo","category":"photo",
    "start_at":"2026-07-01T00:00:00Z","end_at":"2026-08-01T00:00:00Z",
    "criteria":[{"name":"Creativity","weight":60},{"name":"Technique","weight":40}]}'

curl -s localhost:3000/api/contests/1/leaderboard          # JSON
curl -s localhost:3000/api/contests/1/leaderboard?format=csv
curl -N localhost:3000/api/contests/1/stream               # live SSE updates
```
