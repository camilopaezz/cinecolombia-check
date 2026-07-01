# Cinecolombia Digital API — Reference

Field-level reference for the Cinecolombia digital (ticketing/catalog) API. All shapes were **captured live on 2026-07-01** (63 films, 63 availabilities, 50 sites) and decoded from real responses. Use this as a standalone integration guide.

## Platform identity

The Cinecolombia digital API is the **Vista / Lumus "OCAPI"** platform, operated via Moviexchange.

| What | Value |
|---|---|
| API base | `https://digital-api.cinecolombia.com/` |
| API prefix | `https://digital-api.cinecolombia.com/ocapi/v1` |
| Auth issuer | `https://auth.moviexchange.com/` |
| Film/trailer CDN | `https://film-cdn.moviexchange.com/api/cdn` |
| Vista CDN | `https://cineco-digital-cdn.vista.co/` |
| Public site | `https://www.cinecolombia.com/` |

The access token is an **RS256 JWT** (`typ: access_token`, `aud: all`, subject `Cine Colombia / Lumos Plus`), lifetime ~12 h (`exp - nbf = 43200 s`). Verified: a request **without** the `Authorization` header returns **HTTP 401**; **with** it returns data.

## Authentication

There is no documented client-credentials login. The token is published by the public website's SPA seed and must be scraped from the homepage, which sits behind **Cloudflare** (a normal `curl`/`fetch` gets the challenge page; a Chrome-impersonating TLS client is required).

Flow:

1. `GET https://www.cinecolombia.com/` with a Chrome-impersonating client (e.g. `curl-impersonate` / `curl_chrome136`, or a headless browser).
2. Extract the SPA seed: `window.initialData = ({...});` → `JSON.parse`.
3. Read `initialData.api.authToken` (the JWT, ~1285 chars).
4. Call OCAPI endpoints with:
   ```
   Accept: application/json
   Authorization: Bearer <authToken>
   ```

`initialData.api`:

```jsonc
{
  "apiUrl": "https://digital-api.cinecolombia.com/",
  "authToken": "eyJhbGciOiJSUzI1NiIs...",   // RS256 JWT, ~12h life
  "vistaCdn": "https://cineco-digital-cdn.vista.co/",
  "movieExchangeCdn": "https://film-cdn.moviexchange.com/api/cdn"
}
```

`initialData` also contains: `pages`, `captcha`, `connectVersion`, `culture`, `announcements`, `cinemaGroups`, `requiredCinemaGroupPrompt`, `elementDisplayRules`, `loggingConfiguration`, `gtmId`, `rumId`, `siteTitle`, `lumos`, `cinemaUrlsById`, `popups`.

Decoded JWT payload (for reference):

```jsonc
{
  "sub": "rkcyn22nd2jyzykg2yh9xw9jws545svw3",
  "given_name": "Cine Colombia",
  "family_name": "Lumos Plus",
  "vista_organisation_code": "90fw5ctdg3mmfbghsnmwavs02g9",
  "token_usage": "access_token",
  "aud": "all",
  "iss": "https://auth.moviexchange.com/",
  "exp": 1782961346, "iat": 1782918146, "nbf": 1782918146
}
```

## Endpoints

All `GET`, all require the `Authorization: Bearer` header. No pagination observed — `/films` and `/films/availability` return the full network-wide set in one response.

### `GET /ocapi/v1/films` — film catalog

```jsonc
{ "films": [ /* Film[] */ ], "relatedData": { "castAndCrew": [], "genres": [], "censorRatings": [], "events": [] } }
```

**Film object** (real example, `HO00000471` "Toy Story 5"):

```jsonc
{
  "id": "HO00000471",            // primary key; == hopk; the HO id used in site URLs
  "hopk": "HO00000471",          // duplicate of id
  "hoCode": "A000000534",        // internal box-office code
  "eventId": null,               // non-null for event cinema / live viewings
  "title":         { "text": "Toy Story 5", "translations": [{ "languageTag": "en", "text": "Toy Story 5" }] },
  "synopsis":      { "text": "...", "translations": [] },
  "shortSynopsis": { "text": "...", "translations": [] },
  "releaseDate": "2026-06-18",   // ISO date (YYYY-MM-DD)
  "runtimeInMinutes": 102,
  "censorRatingId": "HO00000001",// -> relatedData.censorRatings[].id
  "censorRatingNote": null,
  "genreIds": ["0000000005","0000000008","0000000009"], // -> relatedData.genres[].id
  "castAndCrew": [ { "castAndCrewMemberId": "0000003505", "roles": ["Director"] } /*, ... */ ],
  "actors":    [ { "castAndCrewMemberId": "..." } ],
  "directors": [ { "castAndCrewMemberId": "..." } ],
  "producers": [ { "castAndCrewMemberId": "..." } ],
  "trailers":  [ { "provider": "Moviexchange", "uri": "https://film-cdn.moviexchange.com/api/cdn/release/<uuid>/media/TrailerVideo" } ],
  "trailerUrl": null,
  "displayPriority": 1,
  "externalIds": { "moviexchangeReleaseId": "<uuid>", "corporateId": null },
  "distributorName": "CINECOLOR COLOMBIA S.A.S - DISNEY"
}
```

Text-bearing fields (`title`, `synopsis`, `shortSynopsis`, and all reference-data names) use the localized shape `{ "text": string, "translations": [{ "languageTag": "en", "text": string }] }`. The `text` is the es-CO value; `translations` carries alternates (often just `en`, often empty).

`relatedData` (bundled in the same response, no extra calls):

| Key | Item shape | Count (2026-07-01) |
|---|---|---|
| `castAndCrew` | `{ id, name:{ givenName, familyName, middleName } }` | 614 |
| `genres` | `{ id, name:{text}, description }` | 18 |
| `censorRatings` | `{ id, classification:{text}, classificationDescription:{text}, ageRestriction:{minimumAge} }` | 6 |
| `events` | (empty in this capture) | 0 |

> Cast/crew lives **only** in `relatedData.castAndCrew` now — there is no standalone cast endpoint (see "Endpoints not available" below). Resolve a film's people via `castAndCrew[]` / `actors[]` / `directors[]` / `producers[]` → `castAndCrewMemberId` → `relatedData.castAndCrew[].id`.

### `GET /ocapi/v1/films/availability` — film states

The core "what state is this film in" signal.

```jsonc
{ "filmAvailabilities": [ /* Availability[] */ ], "relatedData": { "attributes": [] } }
```

**Availability object** (real examples):

```jsonc
{
  "filmId": "HO00000386",          // join key -> films[].id
  "siteId": null,                  // null = network-wide; a site id scopes to one cinema
  "categories": ["NowShowing", "AdvanceBooking"],   // the state enum (see table)
  "showtimeAttributeIds": ["0000000004","0000000010"], // -> relatedData.attributes[].id (formats)
  "advanceBookingPeriods": [
    {
      "startsAt": "2025-11-10T06:00:00-05:00",
      "orderBookingModes": ["Paid","Unpaid","UnpaidConfirmed"],
      "restriction": "None",
      "rewardId": null
    }
  ]
}
```

`categories` enum (exhaustive across all entries) and business meaning:

| Category | Public-site section | Meaning |
|---|---|---|
| `NowShowing` | Cartelera | Currently playing |
| `AdvanceBooking` | Preventa | Tickets on sale before release |
| `ComingSoon` | Pronto | Announced, not yet bookable |

Observed combinations: `["NowShowing"]`, `["NowShowing","AdvanceBooking"]`, `["ComingSoon"]`. A film can carry more than one category. Films with `[]` are uncategorized.

`relatedData.attributes` (9, the showtime formats referenced by `showtimeAttributeIds`):

| id | name | id | name |
|---|---|---|---|
| `0000000002` | Megasala | `0000000007` | Doblada |
| `0000000003` | Dinamix | `0000000008` | Subtitulado |
| `0000000004` | 2D | `0000000009` | Onyx |
| `0000000005` | 3D | `0000000010` | Imax |
| `0000000006` | Español | | |

### `GET /ocapi/v1/sites` — cinemas

```jsonc
{ "sites": [ /* Site[] */ ] }   // no relatedData
```

**Site object** (real example, `6118`):

```jsonc
{
  "id": "6118",
  "name": { "text": "PORTAL - RECARGAS", "translations": [] },
  "location": null,
  "contactDetails": {
    "phoneNumbers": [],
    "email": "6118@cinecolombia.com",
    "address": { "line1": "Carrera 13 No. 38 – 85", "line2": "", "city": "Bogotá, Cundinamarco" }
  },
  "ianaTimeZoneName": "America/Bogota",
  "hasSellableItems": true,
  "allowedItemDeliveryMethods": ["CounterPickup"]
}
```

50 sites returned. `id` is the value to pass as `siteId` when scoping availability/showtimes to a single cinema. Sample of the list:

| id | name | city |
|---|---|---|
| 6493 | ANDINO | Bogotá, Cundinamarco |
| 6541 | UNICENTRO | Bogotá, Cundinamarco |
| 6659 | SANTAFE BOGOTA | Bogotá, Cundinamarco |
| 6871 | TITAN PLAZA | Bogotá, Cundinamarco |
| 6192 | VIZCAYA | Medellín, Antioquia |
| 6401 | CARIBE PLAZA | Cartagena, Bolivar |
| 6772 | BUENAVISTA | Barranquilla, Atlántico |
| … | (50 total) | … |

### `GET https://www.cinecolombia.com/sitemap.xml` — film detail URLs

Not part of OCAPI, but the canonical source for each film's public web URL. Standard sitemap (228 URLs total, 63 film-detail URLs matching the 63 films) in the form:

```
https://www.cinecolombia.com/films/<slug>/<HO-id>/
```

e.g. `https://www.cinecolombia.com/films/toy-story-5/HO00000471/`. The `<HO-id>` segment equals `film.id` (`film.hopk`), so a film record can be joined to its web URL by matching that segment. The sitemap is **not** behind Cloudflare and can be fetched with a plain HTTP client.

## Reference data (from `/films` `relatedData`)

**Genres (18):**

| id | name | id | name |
|---|---|---|---|
| `0000000001` | Terror | `0000000011` | Romance |
| `0000000002` | Acción | `0000000013` | Biografía |
| `0000000003` | Crimen | `0000000014` | Historia |
| `0000000004` | Suspenso | `0000000015` | Ciencia Ficción |
| `0000000005` | Animación | `0000000017` | Misterio |
| `0000000006` | Familia | `0000000019` | Musical |
| `0000000007` | Fantasía | `0000000020` | Documental |
| `0000000008` | Aventura | `0000000021` | Música |
| `0000000009` | Comedia | | |
| `0000000010` | Drama | | |

**Censor ratings (6):**

| id | classification | min age |
|---|---|---|
| `HO00000001` | Todos | 0 |
| `HO00000006` | +7 Años | 0 |
| `HO00000004` | +12 Años | 0 |
| `HO00000005` | +15 Años | 0 |
| `HO00000002` | +18 Años | 0 |
| `HO00000007` | Pendiente | 0 |

## Joining the data

- **Film ↔ state**: `films[].id` == `filmAvailabilities[].filmId`. One availability per film (in the network-wide, `siteId: null` response).
- **Film ↔ genres**: `film.genreIds[]` → `relatedData.genres[].id`.
- **Film ↔ censor**: `film.censorRatingId` → `relatedData.censorRatings[].id`.
- **Film ↔ people**: `film.castAndCrew[]` / `actors[]` / `directors[]` / `producers[]` → `.castAndCrewMemberId` → `relatedData.castAndCrew[].id` → `name`.
- **Availability ↔ formats**: `availability.showtimeAttributeIds[]` → `relatedData.attributes[].id`.
- **Film ↔ web URL**: match `film.id` against the `<HO-id>` segment of `/films/<slug>/<HO-id>/` entries in `sitemap.xml`.
- **Site scoping**: `availability.siteId` (null = network-wide) → `sites[].id`.

## curl examples

The homepage needs `curl-impersonate` (Cloudflare). The OCAPI host is not behind Cloudflare, but you need a token obtained from the homepage.

```bash
# 1. Token (Chrome-impersonating client to pass Cloudflare)
html=$(curl_chrome136 -fsSL https://www.cinecolombia.com/)
token=$(node -e 'const h=process.argv[1];const m=h.match(/window\.initialData\s*=\s*({.*?});/s);console.log(JSON.parse(m[1]).api.authToken)' "$html")

# 2. Films (+ relatedData: cast, genres, censor ratings)
curl -fsSL -H "Accept: application/json" -H "Authorization: Bearer $token" \
  https://digital-api.cinecolombia.com/ocapi/v1/films

# 3. Film availability (states + showtime format attributes)
curl -fsSL -H "Accept: application/json" -H "Authorization: Bearer $token" \
  https://digital-api.cinecolombia.com/ocapi/v1/films/availability

# 4. Sites (cinemas)
curl -fsSL -H "Accept: application/json" -H "Authorization: Bearer $token" \
  https://digital-api.cinecolombia.com/ocapi/v1/sites

# 5. Film web URLs (no auth, no impersonation needed)
curl -fsSL https://www.cinecolombia.com/sitemap.xml
```

Without the `Authorization` header, OCAPI returns `401`.

## Endpoints not available

- `GET /ocapi/v1/castandcrewmembers` → **404** (also tried `cast-and-crew-members`, `castandcrew`, `cast`, `crew`). Cast/crew is now delivered **inline** via `/films` `relatedData.castAndCrew`; there is no standalone collection endpoint.
- `/members` → `405` (method not allowed); not the cast endpoint.

Other OCAPI endpoints likely exist (showtimes, sessions, food & beverage, ordering) but are not exercised by a catalog-only integration. Discover them by watching network traffic on the public site with the browser devtools filtered to `digital-api.cinecolombia.com/ocapi/v1`.

## Caveats

- **Cloudflare on the homepage only**: a Chrome-impersonating TLS fingerprint is required to get `initialData`; the OCAPI host itself is not challenged.
- **Token expiry (~12 h)**: re-extract fresh on each run; do not cache long-term.
- **No pagination** observed for `/films`, `/films/availability`, `/sites` — full sets returned in one response.
- **`siteId` is `null`** in the default availability response → states are network-wide. To scope to a cinema, pass its `sites[].id` as `siteId` (mechanism observed in the data; query-string form not pinned down here).
- **Localized text**: every display string is `{ "text": <es-CO>, "translations": [...] }`; always read `.text` (or pick by `languageTag`).
- **Field set is time-stamped**: counts and enum values (genres, censor ratings, attributes, sites) reflect the 2026-07-01 capture; treat them as examples, not constants — re-fetch to get the live set.
