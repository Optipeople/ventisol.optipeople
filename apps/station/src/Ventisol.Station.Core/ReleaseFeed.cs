using System.Text.Json;

namespace Ventisol.Station.Core;

// The Velopack feed (releases.win.json) of the latest GitHub release, read straight from the release
// download link. That link is not GitHub's API, so it has no 60-an-hour limit per IP and every station
// PC can look at it every minute. Only says which version is out; the update itself still goes through
// Velopack.
public static class ReleaseFeed
{
    // https://github.com/owner/repo -> .../releases/latest/download/releases.win.json, or null for anything
    // that isn't a GitHub repo URL.
    public static string? LatestFeedUrl(string repoUrl)
    {
        var url = repoUrl.Trim().TrimEnd('/');
        return url.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase)
            ? $"{url}/releases/latest/download/releases.win.json"
            : null;
    }

    // The highest full-package version in the feed, or null when the feed can't be read.
    public static Version? LatestFullVersion(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("Assets", out var assets) || assets.ValueKind != JsonValueKind.Array) return null;
            Version? best = null;
            foreach (var a in assets.EnumerateArray())
            {
                if (a.ValueKind != JsonValueKind.Object) continue;
                if (!a.TryGetProperty("Type", out var type) || type.GetString() != "Full") continue;
                if (!a.TryGetProperty("Version", out var v) || ParseVersion(v.GetString()) is not { } version) continue;
                if (best is null || version > best) best = version;
            }
            return best;
        }
        catch (JsonException) { return null; }
    }

    // "1.0.6" -> 1.0.6. A pre-release ("1.3.0-beta1") is never one the stations take, so it is null.
    public static Version? ParseVersion(string? text) =>
        text is { Length: > 0 } && !text.Contains('-') && !text.Contains('+') && Version.TryParse(text, out var v) ? v : null;
}
