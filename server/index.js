/**
 * Weather API — Express server that geocodes a user string, then fetches a 7-day
 * daily forecast from Open-Meteo. Geocoding layers: Open-Meteo search, US state
 * disambiguation, and Zippopotam for US ZIP codes when Open-Meteo has no postal hit.
 */
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

/** Identifies this deployment; surfaced on GET /api/health for sanity checks. */
const SERVER_BUILD_ID = "geo-zip-zippo-citystate-v1";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

app.use(cors({ origin: true }));
app.use(express.json());

// --- US geography helpers (state names / abbreviations for parsing & matching) ---

/**
 * @param {string} s
 * @returns {boolean} True if `s` is a US ZIP (5 digits or ZIP+4).
 */
function isUsZipCode(s) {
  return /^\d{5}(-\d{4})?$/.test(s);
}

/**
 * @param {unknown} raw Query `country` param from the client.
 * @returns {string | null} ISO-3166-1 alpha-2 or null if invalid.
 */
function normalizeCountryCode(raw) {
  if (raw == null || raw === "") return null;
  const c = String(raw).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/** Two-letter state / territory codes we treat as trailing tokens (incl. DC). */
const US_STATE_ABBR = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

/** Lowercase two-word state names as they appear after splitting the query on spaces. */
const US_STATE_TWO_WORD = new Set([
  "new york",
  "new jersey",
  "new mexico",
  "new hampshire",
  "north carolina",
  "north dakota",
  "south carolina",
  "south dakota",
  "west virginia",
  "rhode island",
  "district of columbia",
]);

/** Lowercase single-word US state names (last token of "City State"). */
const US_STATE_ONE_WORD = new Set([
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "wisconsin",
  "wyoming",
]);

/** Maps trailing abbreviations to Open-Meteo `admin1` labels (GeoNames). */
const US_STATE_ABBR_TO_ADMIN1 = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

/** Two-word state phrase → Open-Meteo `admin1` string. */
const TWO_WORD_STATE_TO_ADMIN1 = {
  "new york": "New York",
  "new jersey": "New Jersey",
  "new mexico": "New Mexico",
  "new hampshire": "New Hampshire",
  "north carolina": "North Carolina",
  "north dakota": "North Dakota",
  "south carolina": "South Carolina",
  "south dakota": "South Dakota",
  "west virginia": "West Virginia",
  "rhode island": "Rhode Island",
  "district of columbia": "District of Columbia",
};

/** Single-word lowercase state → capitalized admin1 label. */
const US_STATE_WORD_TO_ADMIN1 = Object.fromEntries(
  [...US_STATE_ONE_WORD].map((w) => [
    w,
    w.slice(0, 1).toUpperCase() + w.slice(1),
  ])
);

/**
 * Collapses commas to spaces and trims — improves "Richmond, IN" style input.
 * @param {unknown} query
 * @returns {string}
 */
function normalizeLocationQuery(query) {
  return String(query ?? "")
    .trim()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Compares Open-Meteo `admin1` (e.g. "Indiana") to our target state name.
 * @param {string | undefined} apiAdmin1
 * @param {string} targetAdmin1
 */
function admin1Equals(apiAdmin1, targetAdmin1) {
  if (!apiAdmin1 || !targetAdmin1) return false;
  return (
    String(apiAdmin1).trim().toLowerCase() ===
    String(targetAdmin1).trim().toLowerCase()
  );
}

/**
 * If the query ends with a US state (name or 2-letter), returns city + expected admin1.
 * Used because Open-Meteo often returns no rows for "City State" as one `name` value,
 * and raw "City ST" can match the wrong feature (e.g. airport names containing "IN").
 *
 * @param {string} q Raw or normalized location string
 * @returns {{ city: string, admin1Target: string } | null}
 */
function parseCityStateUs(q) {
  const t = normalizeLocationQuery(q);
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;

  const lastTwo = `${parts[parts.length - 2].toLowerCase()} ${parts[parts.length - 1].toLowerCase()}`;
  if (US_STATE_TWO_WORD.has(lastTwo)) {
    const city = parts.slice(0, -2).join(" ");
    if (!city) return null;
    const admin1Target = TWO_WORD_STATE_TO_ADMIN1[lastTwo];
    return admin1Target ? { city, admin1Target } : null;
  }

  const last = parts[parts.length - 1];
  const lastUpper = last.toUpperCase();
  if (last.length === 2 && US_STATE_ABBR.has(lastUpper)) {
    const city = parts.slice(0, -1).join(" ");
    if (!city) return null;
    const admin1Target = US_STATE_ABBR_TO_ADMIN1[lastUpper];
    return admin1Target ? { city, admin1Target } : null;
  }

  const lastLower = last.toLowerCase();
  if (US_STATE_ONE_WORD.has(lastLower)) {
    const city = parts.slice(0, -1).join(" ");
    if (!city) return null;
    const admin1Target = US_STATE_WORD_TO_ADMIN1[lastLower];
    return admin1Target ? { city, admin1Target } : null;
  }

  return null;
}

/**
 * Strips a trailing US state and returns the city token only (fallback geocode string).
 * @param {string} q Already-normalized query
 * @returns {string | null}
 */
function stripTrailingUsState(q) {
  const parts = q.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const lastTwo = `${parts[parts.length - 2].toLowerCase()} ${parts[parts.length - 1].toLowerCase()}`;
  if (US_STATE_TWO_WORD.has(lastTwo)) {
    return parts.slice(0, -2).join(" ");
  }

  const last = parts[parts.length - 1];
  if (last.length === 2 && US_STATE_ABBR.has(last.toUpperCase())) {
    return parts.slice(0, -1).join(" ");
  }

  const lastLower = last.toLowerCase();
  if (US_STATE_ONE_WORD.has(lastLower)) {
    return parts.slice(0, -1).join(" ");
  }

  return null;
}

/**
 * Calls Open-Meteo geocoding API.
 * @param {string} name Search text (city, ZIP, etc.)
 * @param {string | null} countryCode Optional ISO-2 filter
 * @returns {Promise<{ results: object[] } | { error: string, status: number }>}
 */
async function geocodeSearch(name, countryCode) {
  const url = new URL(GEO_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "20");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  if (countryCode) {
    url.searchParams.set("countryCode", countryCode);
  }

  const res = await fetch(url);
  if (!res.ok) {
    return { error: "Geocoding service unavailable", status: 502 };
  }

  const data = await res.json();
  return { results: data.results ?? [] };
}

/**
 * Picks the first US row if present (used after an unfiltered ZIP search).
 * @param {object[]} results
 */
function pickUsPreferred(results) {
  const us = results.find((r) => r.country_code === "US");
  return us ?? results[0];
}

/**
 * Resolves a US ZIP to lat/lon when Open-Meteo returns no postal results.
 * @param {string} trimmed Normalized ZIP string
 * @returns {Promise<object | null>} Place-shaped object or null
 */
async function geocodeUsZipZippopotam(trimmed) {
  const m = trimmed.match(/^(\d{5})(-\d{4})?$/);
  if (!m) return null;
  const zip5 = m[1];
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip5}`);
    if (!res.ok) return null;
    const j = await res.json();
    const p = j.places?.[0];
    if (!p) return null;
    return {
      id: 0,
      name: p["place name"],
      latitude: parseFloat(p.latitude),
      longitude: parseFloat(p.longitude),
      country_code: "US",
      country: "United States",
      admin1: p.state,
      admin2: "",
      feature_code: "PPL",
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a free-text location to a single Open-Meteo / synthetic place record.
 *
 * @param {unknown} query User input
 * @param {unknown} countryHint Optional `country` query (ISO-2)
 * @returns {Promise<{ place: object } | { error: string, status: number }>}
 */
async function geocode(query, countryHint) {
  const trimmed = normalizeLocationQuery(query);
  if (!trimmed) {
    return { error: "Location is required", status: 400 };
  }

  const zipUs = isUsZipCode(trimmed);
  const explicitCountry = normalizeCountryCode(countryHint);

  let results = [];
  let zipRetriedGlobal = false;

  if (!zipUs && !explicitCountry) {
    const cps = parseCityStateUs(trimmed);
    if (cps) {
      const usR = await geocodeSearch(cps.city, "US");
      if (usR.error) return usR;
      const inState = usR.results.filter(
        (r) =>
          r.country_code === "US" && admin1Equals(r.admin1, cps.admin1Target)
      );
      const pplPool = inState.filter((r) =>
        String(r.feature_code || "").startsWith("PPL")
      );
      const pool = pplPool.length ? pplPool : inState;
      pool.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
      const best = pool[0];
      if (best) {
        return { place: best };
      }
    }
  }

  if (zipUs || explicitCountry) {
    const cc = explicitCountry ?? "US";
    const first = await geocodeSearch(trimmed, cc);
    if (first.error) return first;
    results = first.results;

    if (!results.length && zipUs && !explicitCountry) {
      const second = await geocodeSearch(trimmed, null);
      if (second.error) return second;
      results = second.results;
      zipRetriedGlobal = true;
    }
    if (!results.length && zipUs && !explicitCountry) {
      const zp = await geocodeUsZipZippopotam(trimmed);
      if (zp) {
        results = [zp];
        zipRetriedGlobal = true;
      }
    }
  } else {
    const g = await geocodeSearch(trimmed, null);
    if (g.error) return g;
    results = g.results;

    if (!results.length) {
      const alt = stripTrailingUsState(trimmed);
      if (alt) {
        const again = await geocodeSearch(alt, null);
        if (again.error) return again;
        results = again.results;
      }
    }
  }

  if (!results.length) {
    return { error: `No place found for "${trimmed}"`, status: 404 };
  }

  if (zipUs || explicitCountry) {
    const place = zipRetriedGlobal ? pickUsPreferred(results) : results[0];
    return { place };
  }

  const usMatch = results.find((r) => r.country_code === "US");
  const place = usMatch ?? results[0];
  return { place };
}

/**
 * Fetches 7-day daily forecast (Fahrenheit) for coordinates.
 * @param {number} lat
 * @param {number} lon
 */
async function forecastFor(lat, lon) {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max,relative_humidity_2m_max"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "7");

  const res = await fetch(url);
  if (!res.ok) {
    return { error: "Weather service unavailable", status: 502 };
  }

  const data = await res.json();
  const daily = data.daily;
  if (!daily?.time?.length) {
    return { error: "No forecast data returned", status: 502 };
  }

  const idx = 0;

  return {
    date: daily.time[idx],
    timezone: data.timezone,
    highF: daily.temperature_2m_max?.[idx] ?? null,
    lowF: daily.temperature_2m_min?.[idx] ?? null,
    humidityPct: daily.relative_humidity_2m_max?.[idx] ?? null,
    rainChancePct: daily.precipitation_probability_max?.[idx] ?? null,
    dailySeries: daily.time.map((t, i) => ({
      date: t,
      highF: daily.temperature_2m_max?.[i] ?? null,
      lowF: daily.temperature_2m_min?.[i] ?? null,
      humidityPct: daily.relative_humidity_2m_max?.[i] ?? null,
      rainChancePct: daily.precipitation_probability_max?.[i] ?? null,
    })),
  };
}

/**
 * Human-readable place line for JSON responses.
 * @param {object} p Geocoder place object
 */
function formatPlace(p) {
  const admin = [p.admin1, p.country].filter(Boolean).join(", ");
  return [p.name, admin].filter(Boolean).join(", ");
}

/** Read package.json for health/debug output (best-effort). */
function readPackageMeta() {
  try {
    const raw = readFileSync(join(__dirname, "package.json"), "utf8");
    const j = JSON.parse(raw);
    return { name: j.name, version: j.version };
  } catch {
    return { name: "weather-api", version: "unknown" };
  }
}

/**
 * @param {import('express').Request} req
 * @returns {"minimal" | "instructions" | "debug"}
 */
function resolveHealthMode(req) {
  const d = String(req.query.debug ?? "").toLowerCase();
  if (["1", "true", "yes", "on"].includes(d)) return "debug";

  const mode = String(req.query.mode ?? "").toLowerCase();
  if (mode === "debug" || mode === "full") return "debug";
  if (mode === "instructions" || mode === "help") return "instructions";
  return "minimal";
}

/** Static copy for operators and frontend devs. */
const HEALTH_INSTRUCTIONS = {
  runServer: [
    "From the server folder: npm install && npm start (default port 3000, override with PORT=).",
    "Keep this process running while using the Angular app or direct HTTP tests.",
  ],
  runClient: [
    "From the client folder: npm install && npm start (Angular dev server, usually port 4200).",
    "The dev server proxies /api to http://localhost:3000 (see client/proxy.conf.json).",
  ],
  weatherApi: [
    "Weather data requires a location query parameter: GET /api/weather?q=<text>",
    "Aliases: q or location. Optional: country=<ISO2> to restrict geocoding.",
    "Examples: /api/weather?q=23231 — /api/weather?q=Richmond%20IN — /api/weather?q=Seattle",
    "A bare GET /api/weather with no q returns HTTP 400 with a hint.",
  ],
  healthModes: [
    "GET /api/health — minimal liveness (ok, buildId, uptime).",
    "GET /api/health?mode=instructions — runbook steps + endpoint list (no process dump).",
    "GET /api/health?mode=debug or ?debug=1 — full debug: env, geocode pipeline, package meta.",
  ],
  geocodePipeline: [
    "1) If input looks like City + US state: search city with countryCode=US, filter admin1 to that state (prefers PPL* features).",
    "2) If US ZIP or explicit country: geocode with filter; ZIP may retry without filter, then Zippopotam (api.zippopotam.us).",
    "3) Otherwise: global geocode; prefer first US result; if empty, strip trailing state and retry.",
  ],
  troubleshooting: [
    "Health OK but weather fails: check q is present and URL-encoded (spaces → %20).",
    "Browser shows network error: confirm API is on 3000 and Angular proxy is active (ng serve).",
    "Wrong city: add state (e.g. Richmond IN). Single city name picks the most prominent US match Open-Meteo returns first.",
  ],
};

function healthEndpointsList() {
  return [
    {
      method: "GET",
      path: "/api/health",
      purpose: "Liveness; use mode=instructions or debug=1 for more",
    },
    {
      method: "GET",
      path: "/api/weather",
      purpose: "Forecast JSON",
      query: ["q | location (required)", "country (optional ISO-2)"],
    },
  ];
}

app.get("/api/health", (req, res) => {
  const mode = resolveHealthMode(req);
  const pkg = readPackageMeta();
  const base = {
    ok: true,
    buildId: SERVER_BUILD_ID,
    service: pkg.name,
    version: pkg.version,
    uptimeSeconds: Math.round(process.uptime()),
  };

  if (mode === "minimal") {
    res.json(base);
    return;
  }

  if (mode === "instructions") {
    res.json({
      ...base,
      mode: "instructions",
      instructions: HEALTH_INSTRUCTIONS,
      endpoints: healthEndpointsList(),
    });
    return;
  }

  res.json({
    ...base,
    mode: "debug",
    instructions: HEALTH_INSTRUCTIONS,
    endpoints: healthEndpointsList(),
    process: {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      port: PORT,
      pid: process.pid,
    },
    dataSources: {
      forecast: "Open-Meteo forecast API (CC BY 4.0)",
      geocodePrimary: "Open-Meteo geocoding (GeoNames)",
      geocodeZipFallback: "Zippopotam US ZIP JSON API",
    },
  });
});

app.get("/api/weather", async (req, res) => {
  const q = req.query.q ?? req.query.location;
  const country = req.query.country;
  if (q == null || String(q).trim() === "") {
    return res.status(400).json({
      error:
        'Missing location. Use query parameter q (or location), e.g. /api/weather?q=Richmond%20IN or ?q=23231',
      hint: "See GET /api/health?mode=instructions for examples.",
    });
  }
  const geo = await geocode(q, country);
  if (geo.error) {
    return res.status(geo.status).json({ error: geo.error });
  }

  const { latitude, longitude, name, country_code, admin1 } = geo.place;
  const fc = await forecastFor(latitude, longitude);
  if (fc.error) {
    return res.status(fc.status).json({ error: fc.error });
  }

  res.json({
    query: String(q).trim(),
    location: {
      name,
      admin1: admin1 ?? null,
      countryCode: country_code ?? null,
      latitude,
      longitude,
      label: formatPlace(geo.place),
    },
    today: {
      date: fc.date,
      highF: fc.highF,
      lowF: fc.lowF,
      humidityPct: fc.humidityPct,
      rainChancePct: fc.rainChancePct,
    },
    forecast: fc.dailySeries,
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  });
});

app.listen(PORT, () => {
  console.log(`Weather API listening on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`Instructions: http://localhost:${PORT}/api/health?mode=instructions`);
});
