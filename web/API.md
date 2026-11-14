# C# API client

`PlanetX/Services/SpherexApiClient.cs` replaces the former browser `api.js`.
The Python science backend is unchanged. The ASP.NET Core application calls it
with an injected `HttpClient`; no JavaScript API client remains.

Configure `SpherexApi:BaseUrl` and `SpherexApi:TimeoutSeconds` in
`PlanetX/appsettings.json`, or set `SpherexApi__BaseUrl` and
`SpherexApi__TimeoutSeconds` environment variables. The default timeout is 30 seconds.

## HTTP endpoints

All routes are GET requests under `/api/spherex`:

| Route | Query parameters | Result |
| --- | --- | --- |
| `/health` | — | Upstream health JSON |
| `/targets` | — | Supported cached targets with same-origin `frames_url` |
| `/frames` | `target` | Frames and differences, with absolute image URLs |
| `/spectrum` | `target` | Finite numeric points sorted by wavelength |
| `/frames_by_detector` | `target` | Detector images with absolute URLs |
| `/frames_by_band` | `target` | Ordered bands, absolute WebP URLs and quality metadata |
| `/bands-demo` | — | Redirect to upstream `/static/bands.html` |
| `/diff` | `target`, `a=0`, `b=1` | Image bytes with upstream image content type |
| `/resolve` | `name` | Resolved name with numeric RA/Dec |

For example: `/api/spherex/frames?target=barnards-star`.
Supported targets remain barnards-star, wise-0855-0714, eps-ind-b,
rw-aurigae and r-draconis. This preserves the former client's target restriction.
Image URLs still point to the upstream image/static hosting service, as before.

C# controllers can inject `SpherexApiClient` and call its async methods directly.
`AbsoluteUrl` resolves upstream image paths. `GetDiffUrl` produces an upstream-relative
request path; browser links should use `/api/spherex/diff` instead.
Client validation errors return 400, upstream HTTP errors retain their status,
transport/invalid-response errors return 502, and timeouts return 504.
Upstream response bodies are not exposed in error messages. Request cancellation
propagates to the upstream HTTP request.

The existing target form and star scene are still UI placeholders: this migration
provides the API layer and does not connect the form or observation viewer.

## Validation

Requires .NET 10 SDK:

```sh
dotnet build web/PlanetX/PlanetX.csproj
dotnet run --project web/PlanetX.Tests/PlanetX.Tests.csproj
```

The dependency-free test executable uses a fake HTTP handler to check response
normalization, filtering, binary images, validation, errors, timeout and cancellation.
It does not contact the deployed Python backend.

## Large-field rendering contract

- Read `frame_shape` as `[height, width]` for the native grid and `large_shape`
  as `[height, width]` for the displayed large image. Both are passed through;
  do not hardcode 292, 1024, a square aspect ratio or the old 6x upscale.
- Each frame now has `hero_url`: colour first, then large, then the normal frame.
  All `png_url_*` fields become absolute URLs. Despite their names, they may
  reference WebP. The detector response also exposes its colour `hero_url`
  (null when no colour composite exists).
- The renderer must use linear minification/magnification texture filtering,
  not nearest-neighbour filtering. C# transports image URLs; it does not set
  GPU texture filtering. The existing scene is not wired to observation images.
- Bands with `webp_url: null` and detectors without images remain in the response.
  Preserve their slider positions and display their missing-data notes. Band
  order, wavelength bounds, quality flags, and noise metadata are unchanged.
- Use backend-predicted positions for a motion crosshair, not an image peak or
  a fabricated centre. Current checked-in exports have no predicted-position
  field or coordinate-origin contract. Additional metadata is passed through
  unchanged, but the crosshair needs that backend contract before integration.
  In particular, establish native versus large pixel units and the Y-axis origin
  before converting to display coordinates.
