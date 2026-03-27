# Weather (GibTest1)

Small full-stack sample: an **Angular** client looks up weather by city or US ZIP, and a **Node/Express** API geocodes the query and returns today’s metrics plus a **7-day outlook** from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).

## Repository layout

| Path | Role |
|------|------|
| `client/` | Angular 18 standalone app (`weather-client`) |
| `server/` | Express API (`weather-api`) on port **3000** by default |

## Operation

### Prerequisites

- **Node.js** and npm (for `server` and `client`).

### 1. Start the API

From the `server` folder:

```bash
npm install
npm start
```

The process listens on `http://localhost:3000` unless you set **`PORT`** in the environment. For auto-restart while editing the server, use `npm run dev` (Node `--watch`).

### 2. Start the Angular app

From the `client` folder (in a second terminal):

```bash
npm install
npm start
```

By default the dev server is **`http://localhost:4200`**. It proxies **`/api`** to **`http://localhost:3000`** (see `client/proxy.conf.json`), so the browser calls `/api/weather` and hits the Express app without CORS issues.

### 3. Use the UI

Open the dev URL, enter a **US ZIP**, **city** (add state if ambiguous, e.g. `Richmond IN`), or **city and region**, then submit. The page shows location, today’s high/low/humidity/rain chance, and a table with **Day** and **Date** columns plus forecast highs, lows, humidity, and rain chance.

If the UI shows a network error, confirm the API is running on port 3000 and you started the client with `ng serve` so the proxy is active.

---

## Angular client: components and services

The app is a **single route** (empty `app.routes.ts`); everything runs in the root component.

### `AppComponent` (`client/src/app/app.component.ts`)

Root standalone component: search field, loading/error state, and weather display.

- **`search()`** — Validates non-empty input, clears prior results, calls `WeatherService.getWeather`, and binds success to `result` or sets `error`.
- **`formatTemp` / `formatPct`** — Display helpers for °F and percentages (missing values show an em dash).
- **`formatForecastWeekday` / `formatForecastCalendarDate`** — Locale-aware labels for the 7-day table from API `YYYY-MM-DD` strings, using UTC when parsing so the weekday and calendar date stay aligned with the API’s calendar day.

Template: `app.component.html`. Styles: `app.component.scss`.

### `WeatherService` (`client/src/app/weather.service.ts`)

Injectable HTTP client wrapper: **`getWeather(location)`** sends `GET /api/weather?q=…` (trimmed). Typed as `Observable<WeatherResponse>` per `weather.models.ts`.

### Bootstrap and configuration

- **`main.ts`** — Bootstraps `AppComponent` with `app.config.ts`.
- **`app.config.ts`** — Zone change detection with event coalescing, router (no routes yet), and **`provideHttpClient()`** for API calls.

### Types (`weather.models.ts`)

`WeatherResponse`, `WeatherLocation`, `TodayWeather`, and `DayForecast` mirror the JSON shape returned by `/api/weather`.

---

## Server API and debug

### `GET /api/weather`

| Query | Meaning |
|-------|---------|
| **`q`** or **`location`** | Required. Free-text place or US ZIP. |
| **`country`** | Optional ISO-2 hint for geocoding. |

Returns JSON: `query`, `location` (including `label`, coordinates), `today`, `forecast` (array of daily rows), and `attribution`. A missing `q` returns **400** with a short hint.

### `GET /api/health` — liveness and debug

Used for monitoring and troubleshooting. Response shape depends on **mode** (see below).

**Minimal (default)** — `GET /api/health`

- `ok`, `buildId` (deployment label in code), `service`, `version`, `uptimeSeconds`.

**Instructions** — `GET /api/health?mode=instructions` (or `mode=help`)

- Same base fields plus **`instructions`**: runbook strings for server/client, weather query examples, **health mode** summary, **geocode pipeline** outline, and **troubleshooting** tips.
- Plus **`endpoints`**: short list of API paths and purposes.

**Debug** — any of:

- `GET /api/health?mode=debug`
- `GET /api/health?mode=full`
- `GET /api/health?debug=1` (also `true`, `yes`, `on`)

Includes everything from the instructions response, plus:

- **`process`** — Node version, platform, cwd, **`port`**, **`pid`**.
- **`dataSources`** — Labels for forecast and geocode providers (Open-Meteo, Zippopotam ZIP fallback).

The server also logs the minimal health and instructions URLs on startup.

### Express entrypoint (`server/index.js`)

Geocodes via Open-Meteo search (with US state disambiguation and ZIP handling, including Zippopotam when needed), then fetches the 7-day daily forecast. CORS is enabled for direct browser calls if you ever host the API without the Angular proxy.
