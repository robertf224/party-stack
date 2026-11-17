---
"@party-stack/runtime": minor
"@party-stack/web-runtime": patch
"@party-stack/expo-runtime": minor
---

Runtimes can provide device location. `Runtime.geolocation` (and `Runtimes.geolocation`)
reads positions with the web API's options and fails with a `GeolocationError` whose
`reason` is `PermissionDenied`, `PositionUnavailable` or `Timeout`
(`geolocationErrorCode` maps a reason to the web API's numeric code).

- **web-runtime** provides it over `navigator.geolocation` where available. Unknown
  error codes fail as `PositionUnavailable` rather than leaving a read pending.
- **expo-runtime** provides it through expo-location, now a dependency: permission is
  requested on first use, and a recent last-known fix is used when no fresh one is
  available. Pass `geolocation: false` to leave it out. The config plugin adds only the
  foreground "when in use" purpose string; `locationPermission` replaces or omits it.
