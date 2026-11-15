# Offline copy of the SPHEREx API (filled at deploy time)

On `main` this folder holds only this README. `scripts/update_deploy_web.sh` fills it in the `deploy-web`
branch with the repo's `static_export/` (JSON + WebP/PNG per target, ~19 MB; `before/`, `fov6/` and the HTML
previews are left out), and `web/Dockerfile` copies it to `/app/static_export` in the image.

The frontend's `/api/spherex/*` proxy answers the cached demo targets from it whenever the Python API is
asleep, slow or down (see `web/PlanetX/Services/StaticExport.cs`). With `dotnet run` in `web/PlanetX`, the
proxy finds the repo's `static_export/` directly, so nothing needs copying for local development.
