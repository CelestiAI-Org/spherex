# Frontend image (web/PlanetX, ASP.NET net10.0 + Three.js). Build context: the web/ folder.
#   docker build -t spherex-web web && docker run -e PORT=8080 -p 8080:8080 spherex-web
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY PlanetX/PlanetX.csproj PlanetX/
RUN dotnet restore PlanetX/PlanetX.csproj
COPY PlanetX/ PlanetX/
RUN dotnet publish PlanetX/PlanetX.csproj -c Release -o /app --no-restore -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine
WORKDIR /app
COPY --from=build /app .
# Render sets PORT; listen on 0.0.0.0:$PORT (8080 locally). Render terminates HTTPS and sends
# X-Forwarded-Proto/For, which ASPNETCORE_FORWARDEDHEADERS_ENABLED applies, so the app sees
# https requests and UseHttpsRedirection never loops. The API URL can be overridden with SpherexApi__BaseUrl.
ENV PORT=8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_FORWARDEDHEADERS_ENABLED=true \
    ASPNETCORE_HTTP_PORTS= \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
USER $APP_UID
EXPOSE 8080
CMD ["sh", "-c", "exec dotnet PlanetX.dll --urls http://0.0.0.0:${PORT}"]
