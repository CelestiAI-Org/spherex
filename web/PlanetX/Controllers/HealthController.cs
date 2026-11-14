using Microsoft.AspNetCore.Mvc;

namespace PlanetX.Controllers;

/// <summary>Liveness check for Render. Answers without calling the science API, so a sleeping API never fails it.</summary>
[ApiController]
[Route("health")]
public sealed class HealthController : ControllerBase
{
    [HttpGet, HttpHead]
    public IActionResult Get() => Ok(new { status = "ok", service = "planetx-web" });
}
