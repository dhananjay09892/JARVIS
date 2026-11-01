# Weather (Open-Meteo; OpenWeatherMap in OpenJarvis)

**Kind:** data connector (read-first) · **Auth:** none (Open-Meteo, chosen in C16; OpenWeatherMap needs an api key) · **Platform:** Any · **Risk tier:** R0 · **Priority:** P1
**Reference implementation:** [`src/openjarvis/connectors/weather.py`](https://github.com/open-jarvis/OpenJarvis/blob/main/src/openjarvis/connectors/weather.py) in OpenJarvis (Apache-2.0)

## What it gives JARVIS
Current conditions and forecast for briefings and travel/outfit advice.

## How a user connects it
As built (C16, Open-Meteo): Settings → Connectors → Weather → type your town or city (or "latitude, longitude") under Settings and press Save settings. No account and no key.

OpenJarvis's way (OpenWeatherMap): create a free account at openweathermap.org, copy an API key, paste it and set a home location. Any key would go to the OS keychain (plan 39), never to plain JSON or the relay (plan 41).

## How we implement it in JARVIS
1. **Adapter:** `bridge/connectors/weather.mjs` implementing the connector interface from [the connector framework](../../../README.md#the-jarvis-connector-interface): `connect()`, `disconnect()`, `status()`, `sync({ since, cursor })` yielding `Document` records, optional `search()` and `tools()`.
2. **Auth:** Token or key entered once, validated with a test call, stored in the OS keychain.
3. **Documents:** map to the shared `Document`/`MemoryItem` shapes (plan 38): stable `doc_id`, `source`, `doc_type`, `timestamp`, `participants`, `sensitivity`.
4. **Sync:** incremental by cursor/`since`, backoff on rate limits, scheduled by the event bus (plan 12), manual "Sync now" in Settings.
5. **Policy:** register the connector and each capability with a risk tier (R0); reads are allowed by default for the owner, writes (if any) are separate and approval-gated (plan 15). Everything fetched is **untrusted data** for prompt-injection purposes (plan 08).
6. **Index:** chunk and embed locally (plans 07, 33); answers cite source and date.
7. **Settings:** a card in Settings → Connectors (plan 39) with status dot, last sync, scopes, disconnect and "erase synced data".
8. **Health:** token-expiry detection and plain-language fix-it messages.

### Alternatives to compare before building
- Alternatives with MCP servers exist (AccuWeather, Vaisala Xweather); keep the provider swappable behind one interface.
- Location is personal data; ask for city-level only.

Option B: run OpenJarvis as a sidecar and call its connector (`jarvis connect weather`) through its API instead of re-implementing it; see [../../README.md](../../README.md#how-jarvis-can-use-openjarvis).

## Acceptance tests
- Connect with valid credentials, sync a fixture account, see documents with correct ids and timestamps.
- Wrong or revoked credentials produce a clear error, no crash, no stored garbage.
- Incremental sync returns only new items; rate-limit responses back off.
- Disconnect deletes credentials and (optionally) synced data.
- Prompt-injection fixture in the content cannot trigger an action.
- Nothing from this connector reaches a cloud model unless the user's privacy setting allows it for this source.

## Build log
- **2026-11-01 · C16.** `bridge/connectors/weather.mjs`, registered in the bridge. **Provider: Open-Meteo**, not OpenWeatherMap: no account and no key (nothing to paste, store or leak), free for non-commercial use such as personal home automation, 600/min · 5,000/hour · 10,000/day per IP, data under CC BY 4.0 (every document and tool result carries "Weather data by Open-Meteo.com (CC BY 4.0)"), request logs deleted after 90 days. OpenWeatherMap's free plan needs an account and key and its daily forecast (One Call 3.0) is a separate pay-per-call plan, so it was not chosen; the provider is one object (`OPEN_METEO`: `geocode`, `forecast`, `hosts`) so another can be added behind the same connector. Facts checked 2026-11-01 against open-meteo.com/en/terms, /en/docs and /en/docs/geocoding-api, and openweathermap.org/api. Location comes **only** from the card's settings (a new one-line `text` option type on the Connectors card): a town ("Pune", "Pune, India", "Paris, FR" → `countryCode`) or "lat, lon" (rounded to one decimal); never from the device, IP or calendar. The town name goes to `geocoding-api.open-meteo.com` once per bridge run; forecasts send coordinates rounded to 2 places. Egress allow-list: those two hosts only; no credential is ever sent. Auth `none`, R0, read-only: the card shows "disconnected" with setup steps until a location is saved; clearing the location turns it off; changing it erases the kept copies (C97 options flow). Sync yields two documents with stable ids, `current` and `forecast` (7 days: conditions from WMO codes, high/low, rain chance and amount, wind, sunrise/sunset), sensitivity `location`, so each sync replaces the last. Tool `get_forecast` (1–7 days, default 3) for "Will it rain tomorrow?". Option for °F/mph/inches. Written fresh against Open-Meteo's docs; not ported from OpenJarvis (which uses OpenWeatherMap). Tests: fake Open-Meteo, full vetting test pack (401 bad key, revoked, injection via a geocoded place name, rate limit, offline, erase, no writes, kill switches), fixture forecast, imperial units, coordinates skip the geocoder, unknown town, location change, Open-Meteo's 400 error, malformed replies, tool, Test probe text, and Settings card → save location → Sync now → store → erase. Left: live check (C17); severe-weather alerts and air quality are not built (Open-Meteo has an air-quality API on another host); a briefing (plan 13) can read the two documents or call the tool.

## Related plans
[Connector index](../../../README.md) · [08](../../../../08-data-access-and-safety.md) · [15](../../../../15-policy-trust-and-privacy.md) · [39](../../../../39-settings-and-control-center.md) · [38](../../../../38-shared-data-contracts.md)
