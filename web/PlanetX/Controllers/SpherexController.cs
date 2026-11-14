using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using PlanetX.Services;

namespace PlanetX.Controllers;

[ApiController]
[Route("api/spherex")]
public sealed class SpherexController(SpherexApiClient api) : Controller
{
    public override void OnActionExecuted(ActionExecutedContext context)
    {
        if (context.Exception is SpherexApiException error)
        {
            context.Result = new ObjectResult(new { error = error.Message }) { StatusCode = error.StatusCode };
            context.ExceptionHandled = true;
        }
        base.OnActionExecuted(context);
    }

    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct) => Ok(await api.GetHealthAsync(ct));
    [HttpGet("targets")]
    public async Task<IActionResult> Targets(CancellationToken ct) => Ok(await api.GetTargetsAsync(ct));
    [HttpGet("frames")]
    public async Task<IActionResult> Frames([FromQuery] string target, CancellationToken ct) => Ok(await api.GetFramesAsync(target, ct));
    [HttpGet("spectrum")]
    public async Task<IActionResult> Spectrum([FromQuery] string target, CancellationToken ct) => Ok(await api.GetSpectrumAsync(target, ct));
    [HttpGet("frames_by_detector")]
    public async Task<IActionResult> Detectors([FromQuery] string target, CancellationToken ct) => Ok(await api.GetFramesByDetectorAsync(target, ct));
    [HttpGet("frames_by_band")]
    public async Task<IActionResult> Bands([FromQuery] string target, CancellationToken ct) => Ok(await api.GetFramesByBandAsync(target, ct));
    [HttpGet("bands-demo")]
    public IActionResult BandsDemo() => Redirect(api.GetBandsDemoUrl());
    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve([FromQuery] string name, CancellationToken ct) => Ok(await api.ResolveNameAsync(name, ct));
    [HttpGet("diff")]
    public async Task<IActionResult> Diff([FromQuery] string target, CancellationToken ct, [FromQuery] int a = 0, [FromQuery] int b = 1)
    {
        var image = await api.GetDiffAsync(target, a, b, ct);
        return File(image.Body, image.ContentType);
    }
}
