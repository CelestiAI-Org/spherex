using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;

namespace PlanetX.Controllers;

/// <summary>Same-origin access to the existing Python science API. Image pixels remain upstream.</summary>
[ApiController]
[Route("api/spherex")]
public sealed class SpherexController(IHttpClientFactory clients) : ControllerBase
{
    private static readonly HashSet<string> Endpoints = ["health", "targets", "resolve", "frames", "spectrum", "frames_by_detector", "frames_by_band", "diff"];
    private static readonly HashSet<string> ImageFields = ["url", "png_url", "png_url_large", "png_url_native", "png_url_color", "webp_url"];

    [HttpGet("{endpoint}")]
    public async Task<IActionResult> Get(string endpoint, CancellationToken ct)
    {
        if (!Endpoints.Contains(endpoint)) return NotFound();
        var client = clients.CreateClient("Spherex");
        var query = Request.Query.ToDictionary(p => p.Key, p => (string?)p.Value.ToString());
        try
        {
            using var response = await client.GetAsync(QueryHelpers.AddQueryString(endpoint, query), ct);
            if (!response.IsSuccessStatusCode)
                return StatusCode((int)response.StatusCode, new { error = $"SPHEREx returned HTTP {(int)response.StatusCode}." });
            if (endpoint == "diff")
            {
                var type = response.Content.Headers.ContentType?.MediaType;
                if (type?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) != true)
                    return StatusCode(502, new { error = "Expected an image response." });
                return File(await response.Content.ReadAsByteArrayAsync(ct), type);
            }
            var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct));
            Normalize(json, client.BaseAddress!);
            return new JsonResult(json);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { return StatusCode(504, new { error = "SPHEREx request timed out. Please try again." }); }
        catch (HttpRequestException)
        { return StatusCode(502, new { error = "Cannot reach SPHEREx. Please try again." }); }
        catch (System.Text.Json.JsonException)
        { return StatusCode(502, new { error = "SPHEREx returned invalid JSON." }); }
        catch (InvalidDataException)
        { return StatusCode(502, new { error = "SPHEREx returned an invalid image URL." }); }
    }

    private static void Normalize(JsonNode? node, Uri baseUri)
    {
        if (node is JsonArray array)
        {
            foreach (var item in array) Normalize(item, baseUri);
        }
        else if (node is JsonObject obj)
        {
            foreach (var pair in obj.ToArray())
            {
                if (ImageFields.Contains(pair.Key) && pair.Value is JsonValue value && value.TryGetValue<string>(out var path))
                {
                    if (!Uri.TryCreate(baseUri, path, out var url) || (url.Scheme != "http" && url.Scheme != "https"))
                        throw new InvalidDataException();
                    obj[pair.Key] = url.AbsoluteUri;
                }
                else Normalize(pair.Value, baseUri);
            }
        }
    }
}
