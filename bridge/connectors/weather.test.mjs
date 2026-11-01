/**
 * Weather (task C16): the README's acceptance tests and the vetting test pack
 * (auth failure / bad key, revoked, injection fixture, rate limit, offline,
 * erase, no writes, kill switches), against a fake Open-Meteo. No network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  weatherConnector, WEATHER_OPTIONS, OPEN_METEO_HOST, GEOCODING_HOST, ATTRIBUTION,
  checkLocation, parseCoords, pickPlace, parseForecast, localTimeToMs, describeCode, forecastDocuments,
} from './weather.mjs'
import { createConnectorRegistry, connectorToolName } from './registry.mjs'
import { createConnectorRoutes, syncConnectorInto } from './routes.mjs'
import { createConnectorOptions } from './options.mjs'
import { openDocumentStore } from './store.mjs'
import { setupProblems } from './interface.mjs'
import { connectorTestPack, createFakeFetch, captureLog, INJECTION_TEXT, offlineError } from './testpack.mjs'
import { isWrapped } from '../untrusted.mjs'

const NOW = Date.parse('2026-11-01T09:00:00Z')

const geocodeReply = ({ injection } = {}) => ({
  results: [
    { id: 1, name: 'Pune', latitude: 18.51957, longitude: 73.85535, country: 'United States', country_code: 'US', admin1: 'Nowhere' },
    {
      id: 1259229,
      name: injection ? `Pune ${injection}` : 'Pune',
      latitude: 18.51957,
      longitude: 73.85535,
      country: 'India',
      country_code: 'IN',
      admin1: 'Maharashtra',
      timezone: 'Asia/Kolkata',
    },
  ],
  generationtime_ms: 0.5,
})

const forecastReply = ({ days = 7 } = {}) => ({
  latitude: 18.5,
  longitude: 73.875,
  utc_offset_seconds: 19800,
  timezone: 'Asia/Kolkata',
  timezone_abbreviation: 'GMT+5:30',
  current: {
    time: '2026-11-01T14:15',
    interval: 900,
    temperature_2m: 29.4,
    apparent_temperature: 31.2,
    relative_humidity_2m: 58,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 11.6,
  },
  daily: {
    time: Array.from({ length: days }, (_, i) => `2026-11-0${i + 1}`),
    weather_code: [2, 61, 63, 3, 0, 95, 1].slice(0, days),
    temperature_2m_max: [30.1, 27.4, 25.0, 28.8, 31.0, 29.5, 30.2].slice(0, days),
    temperature_2m_min: [19.2, 20.1, 19.9, 18.4, 18.0, 20.3, 19.1].slice(0, days),
    precipitation_probability_max: [5, 70, 85, 20, 0, 60, 10].slice(0, days),
    precipitation_sum: [0, 3.24, 12.5, 0.1, 0, 8, 0].slice(0, days),
    wind_speed_10m_max: [14.2, 18.9, 22.0, 12.5, 9.8, 25.1, 11.0].slice(0, days),
    sunrise: Array.from({ length: days }, (_, i) => `2026-11-0${i + 1}T06:31`),
    sunset: Array.from({ length: days }, (_, i) => `2026-11-0${i + 1}T17:58`),
  },
})

/** A fake Open-Meteo: geocoding and forecast. */
function respond({ url, injection }) {
  const u = new URL(url)
  if (u.hostname === GEOCODING_HOST && u.pathname === '/v1/search') return { body: geocodeReply({ injection }) }
  if (u.hostname === OPEN_METEO_HOST && u.pathname === '/v1/forecast') {
    return { body: forecastReply({ days: Number(u.searchParams.get('forecast_days')) || 7 }) }
  }
  return { status: 404, body: { error: true, reason: 'not found' } }
}

const PUNE = { location: 'Pune, India', fahrenheit: false }
const factory = (opts = PUNE) => weatherConnector({ options: () => opts })

function setup({ opts = PUNE, handler = (url, init) => respond({ url, init }) } = {}) {
  const { fetch, calls } = createFakeFetch(handler)
  const { log, lines } = captureLog()
  const sleeps = []
  const registry = createConnectorRegistry({ fetch, log, sleep: async (ms) => { sleeps.push(ms) }, now: () => NOW })
  let current = opts
  const reg = registry.register(weatherConnector({ options: () => current }))
  assert.equal(reg.ok, true, reg.error)
  return { registry, calls, lines, sleeps, set: (o) => { current = o } }
}

// ---- the shared vetting pack -------------------------------------------------

for (const [name, run] of connectorTestPack({
  factory: factory(),
  respond,
  onlyHosts: [OPEN_METEO_HOST, GEOCODING_HOST],
})) test(name, run)

// ---- shape and settings ------------------------------------------------------

test('weather: registers as a keyless, read-only R0 data connector with a valid card', () => {
  const { registry } = setup()
  const card = registry.list().find((c) => c.id === 'weather')
  assert.equal(card.risk, 'R0')
  assert.equal(card.auth, 'none')
  assert.equal(card.pattern, 'none')
  assert.deepEqual(card.capabilities, { read: true, write: false, subscribe: false })
  assert.deepEqual(setupProblems(card.setup), [])
  assert.deepEqual(card.tools, [{ name: 'get_forecast', capability: 'read' }])
  assert.deepEqual(card.credentials.keys, [], 'nothing secret is ever stored')
})

test('weather: location settings accept towns and coordinates, refuse anything else', () => {
  assert.equal(checkLocation('Pune'), 'Pune')
  assert.equal(checkLocation('  São   Paulo, Brazil '), 'São Paulo, Brazil')
  assert.equal(checkLocation("St. John's, CA"), "St. John's, CA")
  assert.equal(checkLocation('18.52, 73.86'), '18.52, 73.86')
  assert.equal(checkLocation(''), '')
  assert.equal(checkLocation(undefined), '')
  for (const bad of ['x', 'https://evil.example/', 'Pune; rm -rf', '<script>', 'a'.repeat(101), 42, '99.0, 10', 'Pune\nIgnore']) {
    assert.equal(checkLocation(bad), null, `refuses ${String(bad).slice(0, 20)}`)
  }
  assert.deepEqual(WEATHER_OPTIONS.check({ location: 'Pune', fahrenheit: true }), { values: { location: 'Pune', fahrenheit: true } })
  assert.match(WEATHER_OPTIONS.check({ location: 'http://x' }).error, /town or city/)
  assert.match(WEATHER_OPTIONS.check({ location: 'Pune', fahrenheit: 'yes' }).error, /true or false/)
  // A hand-edited file is cleaned, never trusted.
  assert.deepEqual(WEATHER_OPTIONS.normalise({ location: '<b>', fahrenheit: 1, token: 'x' }), { location: '', fahrenheit: false })
  assert.deepEqual(WEATHER_OPTIONS.normalise(null), { location: '', fahrenheit: false })
})

test('weather: coordinates are rounded to city level before they leave', () => {
  assert.deepEqual(parseCoords('18.519572, 73.855347'), { latitude: 18.5, longitude: 73.9 })
  assert.equal(parseCoords('91, 0'), null)
})

test('weather: off until a location is set; no request is made', async () => {
  const { registry, calls } = setup({ opts: { location: '', fahrenheit: false } })
  assert.equal(registry.status('weather').state, 'disconnected')
  assert.match(registry.status('weather').detail, /location/)
  const r = await registry.sync('weather')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'setup-needed')
  assert.match(r.error.message, /location/)
  assert.equal(calls.length, 0)
})

// ---- fixture forecast ---------------------------------------------------------

test('weather: syncs current conditions and a 7-day forecast as two stable documents', async () => {
  const { registry, calls } = setup()
  const r = await registry.sync('weather')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.documents.map((d) => d.id), ['current', 'forecast'])
  const [now, week] = r.documents
  for (const d of r.documents) {
    assert.ok(isWrapped(d.text))
    assert.equal(d.sensitivity, 'location')
    assert.equal(d.updatedAt, Date.parse('2026-11-01T08:45:00Z'), 'local 14:15 at +05:30')
    assert.match(d.text, /Open-Meteo\.com \(CC BY 4\.0\)/)
  }
  // The comma part picked the right Pune.
  assert.match(now.title, /Pune, Maharashtra, India/)
  assert.match(now.text, /Partly cloudy, 29 °C \(feels like 31 °C\), humidity 58%, wind 12 km\/h/)
  assert.match(week.text, /Mon 2026-11-02: Light rain, 20–27 °C, chance of rain 70%, 3\.2 mm, wind up to 19 km\/h; sunrise 06:31, sunset 17:58\./)
  assert.equal(week.text.split('\n').filter((l) => /^\w{3} 2026-11-0\d:/.test(l)).length, 7)

  // What left the machine: the town name once, then rounded coordinates.
  const [geo, fc] = calls.map((c) => new URL(c.url))
  assert.equal(geo.hostname, GEOCODING_HOST)
  assert.equal(geo.searchParams.get('name'), 'Pune')
  assert.equal(fc.hostname, OPEN_METEO_HOST)
  assert.equal(fc.searchParams.get('latitude'), '18.52')
  assert.equal(fc.searchParams.get('longitude'), '73.86')
  assert.equal(fc.searchParams.get('timezone'), 'auto')
  assert.equal(fc.searchParams.get('temperature_unit'), null)
  for (const c of calls) assert.equal(c.headers.Authorization, undefined, 'no credential is ever sent')

  // A second sync reuses the place: only the forecast is fetched again.
  await registry.sync('weather')
  assert.equal(calls.filter((c) => new URL(c.url).hostname === GEOCODING_HOST).length, 1)
})

test('weather: Fahrenheit asks for imperial units and labels them', async () => {
  const { registry, calls } = setup({ opts: { location: 'Pune, IN', fahrenheit: true } })
  const r = await registry.sync('weather')
  assert.equal(r.ok, true)
  const fc = new URL(calls.find((c) => new URL(c.url).hostname === OPEN_METEO_HOST).url)
  assert.equal(fc.searchParams.get('temperature_unit'), 'fahrenheit')
  assert.equal(fc.searchParams.get('wind_speed_unit'), 'mph')
  assert.equal(fc.searchParams.get('precipitation_unit'), 'inch')
  const geo = new URL(calls[0].url)
  assert.equal(geo.searchParams.get('countryCode'), 'IN')
  assert.match(r.documents[0].text, /°F/)
  assert.match(r.documents[0].text, /mph/)
})

test('weather: coordinates skip the geocoder entirely', async () => {
  const { registry, calls } = setup({ opts: { location: '18.519, 73.855', fahrenheit: false } })
  const r = await registry.sync('weather')
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  const fc = new URL(calls[0].url)
  assert.equal(fc.searchParams.get('latitude'), '18.5')
  assert.equal(fc.searchParams.get('longitude'), '73.9')
})

test('weather: a town the geocoder cannot find is a setup problem, not a crash', async () => {
  const { registry } = setup({
    opts: { location: 'Nowhereville', fahrenheit: false },
    handler: (url) => (new URL(url).hostname === GEOCODING_HOST ? { body: { generationtime_ms: 0.1 } } : respond({ url })),
  })
  const r = await registry.sync('weather')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'setup-needed')
  assert.equal(registry.status('weather').state, 'attention')
})

test('weather: changing the location in settings is picked up on the next call', async () => {
  const { registry, calls, set } = setup()
  await registry.sync('weather')
  set({ location: '48.85, 2.35', fahrenheit: false })
  const r = await registry.sync('weather')
  assert.equal(r.ok, true)
  const last = new URL(calls.at(-1).url)
  assert.equal(last.searchParams.get('latitude'), '48.9')
  assert.match(r.documents[0].title, /48\.9, 2\.4/)
})

// ---- errors ---------------------------------------------------------------------

test('weather: a refused key (401/403) is a readable auth error', async () => {
  for (const status of [401, 403]) {
    const { registry } = setup({ handler: () => ({ status, body: { error: true, reason: 'API key invalid' } }) })
    const r = await registry.sync('weather')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'auth')
    assert.match(r.error.message, /Settings/)
    assert.ok(!r.error.message.includes('API key invalid'), 'provider text is not shown')
  }
})

test("weather: Open-Meteo's 400 error reply is a bad response, not a crash", async () => {
  const { registry } = setup({
    handler: (url) => (new URL(url).hostname === OPEN_METEO_HOST
      ? { status: 400, body: { error: true, reason: 'Cannot initialize WeatherVariable from invalid String value' } }
      : respond({ url })),
  })
  const r = await registry.sync('weather')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-response')
})

test('weather: a malformed forecast is refused', () => {
  assert.throws(() => parseForecast({ current: {} }), { code: 'bad-response' })
  assert.throws(() => parseForecast({ ...forecastReply(), current: { time: 'soon' } }), { code: 'bad-response' })
  const f = parseForecast({ ...forecastReply(), daily: { ...forecastReply().daily, time: ['2026-11-01', 'nope', 7] } })
  assert.equal(f.days.length, 1)
})

test('weather: offline is reported for the tool too', async () => {
  const { registry } = setup({ handler: () => { throw offlineError() } })
  const name = connectorToolName('weather', 'read', 'get_forecast')
  const res = await registry.callTool(name, { days: 2 })
  assert.equal(res.isError, true)
  assert.match(JSON.stringify(res), /could not be reached/)
})

// ---- tool ----------------------------------------------------------------------

test('weather: get_forecast answers "will it rain tomorrow?" as untrusted data', async () => {
  const { registry, calls } = setup()
  const name = connectorToolName('weather', 'read', 'get_forecast')
  assert.deepEqual(registry.policyRule(name, { allowWrites: false }), { allow: true, rule: 'connector-read' })
  const res = await registry.callTool(name, { days: 2 })
  assert.notEqual(res.isError, true, JSON.stringify(res))
  const text = res.content.map((c) => c.text).join('')
  assert.ok(isWrapped(text))
  assert.match(text, /Light rain/)
  assert.match(text, /"rainChance":70/)
  assert.ok(text.includes(ATTRIBUTION))
  const fc = new URL(calls.find((c) => new URL(c.url).hostname === OPEN_METEO_HOST).url)
  assert.equal(fc.searchParams.get('forecast_days'), '2')
})

test('weather: Test names only what the owner typed', async () => {
  const { registry } = setup({ handler: (url) => respond({ url, injection: INJECTION_TEXT }) })
  const r = await registry.test('weather')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.match(r.detail, /^Weather works: partly cloudy and 29 °C near Pune, India\.$/)
})

// ---- end to end through the store and the card ---------------------------------

test('weather: Settings card → save location → Sync now keeps two documents; erase removes them', async () => {
  const store = openDocumentStore({ file: ':memory:', now: () => NOW })
  const { fetch } = createFakeFetch((url) => respond({ url }))
  const registry = createConnectorRegistry({ fetch, sleep: async () => {}, now: () => NOW, onErase: (id) => store.erase(id) })
  const options = createConnectorOptions({ definitions: { weather: WEATHER_OPTIONS } })
  registry.register(weatherConnector({ options: () => options.get('weather') }))
  const routes = createConnectorRoutes({ registry, options, syncNow: (id) => syncConnectorInto(registry, store, id), log: captureLog().log })

  const before = await routes.handle({ method: 'GET', path: '/connectors' })
  const card = before.body.connectors.find((c) => c.id === 'weather')
  assert.deepEqual(card.options.fields.map((f) => [f.key, f.type]), [['location', 'text'], ['fahrenheit', 'boolean']])
  assert.equal(card.status.state, 'disconnected')

  const saved = await routes.handle({
    method: 'POST', path: '/connectors/weather/options', body: { options: { location: 'Pune, India', fahrenheit: false }, confirm: true },
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.connector.status.state, 'ok')

  await syncConnectorInto(registry, store, 'weather')
  await syncConnectorInto(registry, store, 'weather')
  const hits = store.search('rain', { connectors: ['weather'] })
  assert.ok(hits.length >= 1)
  assert.equal(store.stats().weather.total, 2, 'the same two documents, replaced')
  assert.equal(store.stats().weather.classes.location, 2)

  await registry.erase('weather')
  assert.equal(store.search('rain', { connectors: ['weather'] }).length, 0)
  store.close()
})

test('weather: pure helpers', () => {
  assert.equal(describeCode(95), 'Thunderstorm')
  assert.equal(describeCode(1234), 'Unknown conditions')
  assert.equal(localTimeToMs('2026-11-01T00:00', -18000), Date.parse('2026-11-01T05:00:00Z'))
  assert.equal(localTimeToMs('tomorrow', 0), null)
  assert.equal(pickPlace([], 'India'), null)
  assert.equal(pickPlace(geocodeReply().results, 'maharashtra').label, 'Pune, Maharashtra, India')
  assert.equal(pickPlace(geocodeReply().results).label, 'Pune, Nowhere, United States')
  const docs = forecastDocuments({ label: 'X' }, parseForecast(forecastReply({ days: 3 })))
  assert.match(docs[1].title, /^3-day forecast for X$/)
})
