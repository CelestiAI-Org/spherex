using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using PlanetX.Services;

namespace PlanetX.Controllers;

/// <summary>
/// Same-origin access to the Python science API, built so the site never looks down:
///  * every call is retried (see <see cref="SpherexUpstream"/>) while a sleeping API wakes;
///  * the read endpoints for the cached demo targets fall back to the offline copy (<see cref="StaticExport"/>)
///    if the API fails, or has not answered within SpherexApi:LocalFallbackAfterSeconds, or failed in the last minute;
///  * images of the cached targets are served from here (same origin), so they never wait on the API either.
/// The X-Spherex-Source response header says where an answer came from: "live" or "offline".
/// </summary>
[ApiController]
[Route("api/spherex")]
public sealed class SpherexController(SpherexUpstream upstream, StaticExport offline, ILogger<SpherexController> log) : ControllerBase
{
    private const string LocalImagePrefix = "/api/spherex/static/";
    private static readonly HashSet<string> Endpoints = ["health", "targets", "resolve", "frames", "spectrum", "frames_by_detector", "frames_by_band", "diff"];
    private static readonly HashSet<string> ImageFields = ["url", "png_url", "png_url_large", "png_url_native", "png_url_color", "webp_url"];

    [HttpGet("{endpoint}")]
    public async Task<IActionResult> Get(string endpoint, CancellationToken ct)
    {
        if (!Endpoints.Contains(endpoint)) return NotFound();
        var local = offline.Answer(endpoint, Request.Query);
        if (local is not null && upstream.RecentlyDown)
        {
            upstream.WakeInBackground();
            return Local(local);
        }

        var query = Request.Query.ToDictionary(p => p.Key, p => (string?)p.Value.ToString());
        using var callCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var call = upstream.GetAsync(QueryHelpers.AddQueryString(endpoint, query), callCts.Token);
        if (local is not null && await Task.WhenAny(call, Task.Delay(upstream.LocalFallbackAfter, ct)) != call)
        {
            // The API is probably waking up: answer from the offline copy now, and let it finish waking in the background.
            log.LogInformation("SPHEREx API slow on /{Endpoint}; answering from the offline copy", endpoint);
            callCts.Cancel();
            _ = call.ContinueWith(t => t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            upstream.MarkSlow();
            upstream.WakeInBackground();
            return Local(local);
        }

        UpstreamResponse response;
        try { response = await call; }
        catch (UpstreamUnavailableException)
        {
            if (local is not null) return Local(local);
            // The page pings health on load to wake the API: answer 200 so a visitor's console shows no error,
            // and say in the body that the cached targets are being served offline (the keep-alive checks this).
            if (endpoint == "health")
                return Ok(new { status = "offline", api = "unreachable", offline_targets = offline.Keys });
            return StatusCode(503, new
            {
                error = endpoint == "resolve"
                    ? "Looking up new names needs the live data service, which is not answering right now. The cached targets still work."
                    : "The SPHEREx data service is not answering right now. Please try again in a minute.",
                waking = true,
                offline_targets = offline.Keys,
            });
        }

        Response.Headers["X-Spherex-Source"] = "live";
        var status = (int)response.Status;
        if (status >= 500 && local is not null) return Local(local);
        if (status >= 400)
        {
            // Pass the API's own error message through (it explains 404s such as an uncached target).
            JsonNode? body = null;
            try { body = JsonNode.Parse(response.Body); } catch (System.Text.Json.JsonException) { }
            return StatusCode(status, body is JsonObject ? body : new JsonObject { ["error"] = $"SPHEREx returned HTTP {status}." });
        }
        try
        {
            if (endpoint == "diff")
            {
                if (response.MediaType?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) != true)
                    return local is not null ? Local(local) : StatusCode(502, new { error = "Expected an image response." });
                return File(response.Body, response.MediaType);
            }
            var json = JsonNode.Parse(response.Body);
            Normalize(json, LiveImageUrl);
            return new JsonResult(json);
        }
        catch (Exception e) when (e is System.Text.Json.JsonException or InvalidDataException)
        {
            return local is not null ? Local(local) : StatusCode(502, new { error = "SPHEREx returned an unexpected answer." });
        }
    }

    /// <summary>Images of the offline copy (static_export/&lt;target&gt;/...), same origin as the page.</summary>
    [HttpGet("static/{**path}")]
    [ResponseCache(Duration = 86400, Location = ResponseCacheLocation.Any)]
    public IActionResult Image(string path)
    {
        var file = offline.ImagePath(path);
        if (file is null) return NotFound();
        return PhysicalFile(file, Path.GetExtension(file).Equals(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/webp");
    }

    private IActionResult Local(LocalAnswer answer)
    {
        Response.Headers["X-Spherex-Source"] = "offline";
        if (answer.FilePath is not null)
            return PhysicalFile(answer.FilePath, answer.FilePath.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/webp");
        Normalize(answer.Json, path => path.StartsWith("/static/", StringComparison.Ordinal) ? LocalImagePrefix + path["/static/".Length..] : path);
        return answer.Status == 200 ? new JsonResult(answer.Json) : StatusCode(answer.Status, answer.Json);
    }

    /// <summary>An image path from the API: same origin if the offline copy has that file, else absolute on the API host.</summary>
    private string LiveImageUrl(string path)
    {
        if (path.StartsWith("/static/", StringComparison.Ordinal) && offline.ImagePath(path["/static/".Length..]) is not null)
            return LocalImagePrefix + path["/static/".Length..];
        if (!Uri.TryCreate(upstream.BaseAddress, path, out var url) || (url.Scheme != "http" && url.Scheme != "https"))
            throw new InvalidDataException();
        return url.AbsoluteUri;
    }

    private static void Normalize(JsonNode? node, Func<string, string> imageUrl)
    {
        if (node is JsonArray array)
        {
            foreach (var item in array) Normalize(item, imageUrl);
        }
        else if (node is JsonObject obj)
        {
            foreach (var pair in obj.ToArray())
            {
                if (ImageFields.Contains(pair.Key) && pair.Value is JsonValue value && value.TryGetValue<string>(out var path))
                    obj[pair.Key] = imageUrl(path);
                else Normalize(pair.Value, imageUrl);
            }
        }
    }
}
