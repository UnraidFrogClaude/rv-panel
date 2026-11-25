// Forecast from Open-Meteo, alerts and nearest town from the US National Weather Service. Neither needs a key.
// Only a location rounded to two decimals (about half a mile) is ever sent.

export const roundPlace = (n) => Number(Number(n).toFixed(2));

const CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Storms', 96: 'Storms, hail', 99: 'Storms, hail',
};
const codeText = (c) => CODES[c] || 'Unknown';
const compass = (d) => (Number.isFinite(d) ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8] : '');
const val = (n) => (Number.isFinite(n) ? n : null);

/** '2026-11-25T16:38', already in the place's own time zone, to '4:38 PM'. */
export function clock(iso) {
  const m = /T(\d\d):(\d\d)/.exec(iso || '');
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
function dayName(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
}

export function decodeForecast(j) {
  const c = j?.current, d = j?.daily;
  if (!c || !Number.isFinite(c.temperature_2m) || !Array.isArray(d?.time)) throw new Error('The forecast reply was not usable');
  return {
    temp: c.temperature_2m, feels: val(c.apparent_temperature), humidity: val(c.relative_humidity_2m), sky: codeText(c.weather_code),
    wind: val(c.wind_speed_10m), gust: val(c.wind_gusts_10m), from: compass(c.wind_direction_10m),
    sunrise: clock(d.sunrise?.[0]), sunset: clock(d.sunset?.[0]),
    days: d.time.map((t, i) => ({
      name: dayName(t), sky: codeText(d.weather_code?.[i]), high: val(d.temperature_2m_max?.[i]), low: val(d.temperature_2m_min?.[i]),
      rain: val(d.precipitation_probability_max?.[i]), gust: val(d.wind_gusts_10m_max?.[i]),
    })),
  };
}

export function decodeAlerts(j) {
  if (!Array.isArray(j?.features)) throw new Error('The alert reply was not usable');
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
  return j.features.map((f) => f.properties).filter((p) => p?.event && p.status !== 'Test' && p.messageType !== 'Cancel').map((p) => ({
    event: p.event, severity: p.severity || 'Unknown', until: Date.parse(p.ends || p.expires) || null,
    headline: p.headline || '', text: [p.description, p.instruction].filter(Boolean).join('\n\n'),
  })).sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
}
export const activeAlerts = (list, now = Date.now()) => list.filter((a) => a.until === null || a.until > now);

async function get(url) {
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), 15000);
  try { return await fetch(url, { signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch { throw new Error('No internet, or the weather service is not answering.'); }
  finally { clearTimeout(t); }
}

export async function forecast(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 4, temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max,sunrise,sunset',
  });
  const r = await get(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!r.ok) throw new Error(`The weather service answered ${r.status}.`);
  return decodeForecast(await r.json());
}

/** status is 'ok', 'outside' (not covered by the US service) or 'failed'. A failure is never reported as "no alerts". */
export async function alerts(lat, lon) {
  try {
    const r = await get(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    if (r.status === 400 || r.status === 404) return { status: 'outside', list: [] };
    if (!r.ok) throw new Error(`answered ${r.status}`);
    return { status: 'ok', list: decodeAlerts(await r.json()) };
  } catch { return { status: 'failed', list: [] }; }
}

export async function nearestTown(lat, lon) {
  try {
    const r = await get(`https://api.weather.gov/points/${lat},${lon}`);
    const p = (await r.json()).properties?.relativeLocation?.properties;
    return p?.city ? `Near ${p.city}, ${p.state}` : null;
  } catch { return null; }
}

export async function findPlace(text) {
  const name = text.split(',')[0].trim();
  if (name.length < 2) throw new Error('Enter a town name or ZIP code.');
  const r = await get(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: 10, language: 'en', format: 'json' })}`);
  if (!r.ok) throw new Error(`The place search answered ${r.status}.`);
  const list = ((await r.json()).results || []).map((p) => ({ lat: roundPlace(p.latitude), lon: roundPlace(p.longitude), name: [p.name, p.admin1, p.country_code].filter(Boolean).join(', '), us: p.country_code === 'US' }));
  return list.sort((a, b) => b.us - a.us).slice(0, 6);
}

export function locate() {
  return new Promise((yes, no) => {
    if (!navigator.geolocation) { no(new Error('This browser does not share location. Enter a place instead.')); return; }
    const said = { 1: 'Location is blocked. Allow it for Bluefy in the iPad’s Settings, Privacy & Security, Location Services, or enter a place.',
      2: 'The iPad could not work out where it is.', 3: 'Finding your location took too long.' };
    navigator.geolocation.getCurrentPosition((p) => yes({ lat: roundPlace(p.coords.latitude), lon: roundPlace(p.coords.longitude) }),
      (e) => no(new Error(said[e?.code] || 'Location was not available.')), { maximumAge: 300000, timeout: 20000 });
    // A browser that never answers must not block the forecast for good.
    setTimeout(() => no(new Error(said[3])), 60000);
  });
}
