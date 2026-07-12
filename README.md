# 🏁 VeloGripScorer

A race-timing platform in the spirit of webscorer.com: organizers create **races**,
build start lists (bib / name / category / wave), start waves with a gun time, and
the public watches **live results** — Place, Bib, Category place, Laps, Time, Behind,
DNS/DNF/DSQ — updated in real time from RFID chip reads delivered by the companion
**Android timing app** (`android/`). A second contest type, community-voting
competitions with weighted judging criteria, is also included.

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
| `DISABLE_RATE_LIMIT` | unset | Disables rate limiting (tests only) |

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
