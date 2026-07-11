# 🏆 VeloGripScorer

An online scoring & competition platform (in the spirit of webscorer.com): users create
contests with **weighted judging criteria**, participants submit entries (text, code,
images, video, PDF), the community casts **per-criterion votes**, and the platform
aggregates weighted scores into **live leaderboards**.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # integration test suite (node:test + supertest)
```

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
**VeloGrip RFID** — a zero-dependency Java Android app that connects to your RFID
system's WiFi router, talks TCP to the RFID reader on that network, and streams tag
reads to this server:

```
[RFID reader] --TCP over reader WiFi--> [VeloGrip RFID app] --HTTPS (cellular)--> [server]
```

### Setup

1. **Web**: open your contest → **Timing** tab → *Add reader* → copy the device token.
2. **App**: install `app-debug.apk` (built by the `Android APK` CI job — download the
   `velogrip-rfid-debug-apk` artifact from the Actions tab, or run
   `cd android && gradle assembleDebug` with the Android SDK installed).
3. In the app settings enter:
   - **Server URL** + **reader device token** (from step 1) — *Test server connection*
     verifies both.
   - **Reader IP/port** — the RFID reader's address on the router's LAN.
   - **Protocol** — `ASCII lines` for readers/timing boxes that stream an EPC per line,
     `UHF binary frames` for the common `0xA0`-framed UHF reader modules
     (Chafon/Rodinbell/Impinj-module clones, real-time inventory `cmd 0x89/0x8B`,
     RSSI = byte − 129), or `Demo mode` to test the whole pipeline with fake reads.
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

Reader management, ingestion (`POST /api/ingest/reads` with `X-Reader-Token`),
tag assignment, and passings endpoints are documented in `openapi.yaml`.

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
