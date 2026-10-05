# Vibi backend

Link analysis, Google place photos/details and day optimization for the Vibi app.
Listens on port **3030**. `/health` is open; everything under `/api` needs the shared `API_TOKEN`.

What a shared link goes through:

- **TikTok / Instagram:** the video is downloaded with [yt-dlp](https://github.com/yt-dlp/yt-dlp),
  then its speech (Whisper), frames (shop signs, on-screen text) and caption are analyzed together.
- **YouTube:** captions (or the transcribed audio), chapters and description; long videos are read
  in parts and can yield up to 30 places.
- **Google Maps links:** the place is looked up directly (Places API), no AI involved.
- **Uploaded videos:** analyzed like downloaded ones and kept for 30 days so "Analyze again" works.

Progress and results are written to Supabase so every traveler's phone sees them.

## Deploy to the VPS (Docker)

1. Copy this folder to the server, without build output. From the repo root:

   ```bash
   tar --exclude=node_modules --exclude=dist --exclude=data -czf vibi-backend.tgz backend
   scp vibi-backend.tgz <user>@43.133.142.153:~
   ssh <user>@43.133.142.153 "tar xzf vibi-backend.tgz"
   ```

   The archive includes `backend/.env` (API keys and `API_TOKEN`), so keep it private and delete
   it after copying.

2. On the server:

   ```bash
   cd backend
   docker compose up -d --build
   ```

3. Allow inbound TCP **3030** in the cloud firewall (Tencent Cloud: Lighthouse → Firewall, or
   CVM → Security group).

4. Check it: `curl http://43.133.142.153:3030/health` should return `"status":"ok"`.

**Update:** `git pull`, then `docker compose up -d --build` again. yt-dlp updates itself each time
the container starts (set `YTDLP_AUTO_UPDATE=false` in `.env` to turn that off), so if TikTok or
Instagram imports start failing, `docker compose restart` usually fixes it.
**Logs:** `docker compose logs -f`. **Stop:** `docker compose down`.

Import jobs live in memory, so restarting the container fails any import that's in progress; the
app shows those with a Retry button.

## Configuration

Copy `.env.example` to `.env` and fill it in. The container refuses to start without an
`API_TOKEN` of 16+ characters. The Android app needs the same value as `TRIPWEAVE_API_TOKEN` in
`android/local.properties`, plus `TRIPWEAVE_API_URL=http://43.133.142.153:3030`.

## Free-tier guard

The server counts what it spends each month and shows it in the app (Trip tab, plus a warning
banner at 50% and 80%). At **90%** it stops calling that API until the next month, so the last 10%
of the free allowance is never touched.

- **Google Maps:** every Places request is counted against its SKU's monthly free calls (5,000 for
  Pro SKUs such as place search, 1,000 for Enterprise SKUs such as ratings/hours and photos). Photo
  lists use Google's free "IDs only" lookup, ratings and hours are only fetched for the place
  screen, place matches are reused for 30 days and photos are cached on disk for 30 days.
- **OpenAI:** spend is estimated from the tokens and audio minutes each call reports, against
  `OPENAI_MONTHLY_BUDGET_USD` (default 5).

Counts live in `data/usage.json` (kept across rebuilds by the `vibi-data` volume) and start from
zero on the first deploy; check the Google Cloud and OpenAI dashboards for anything spent before.
`GET /api/usage` returns the current numbers.

Imports are analyzed `MAX_CONCURRENT_IMPORTS` at a time (default 2); the rest wait in line and the
app shows their place in it.

## Local development

```bash
npm install
npm run dev     # hot reload on http://localhost:3030 (emulator: http://10.0.2.2:3030)
npm test
```

# itinerary-backend
