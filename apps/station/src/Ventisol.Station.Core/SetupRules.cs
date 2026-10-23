namespace Ventisol.Station.Core;

// What the setup screen checks before it saves. Texts are Danish: they are shown as they are.
public static class SetupRules
{
    // An account id as typed: blank is "not set yet", otherwise a GUID (with or without braces).
    public static bool TryParseAccountId(string? text, out Guid? id)
    {
        id = null;
        if (string.IsNullOrWhiteSpace(text)) return true;
        if (!Guid.TryParse(text.Trim(), out var g) || g == Guid.Empty) return false;
        id = g;
        return true;
    }

    public static bool IsValidApiUrl(string? text) =>
        Uri.TryCreate(text?.Trim(), UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp) && !string.IsNullOrEmpty(u.Host);

    // Everything that stops a save, in the order the screen shows it. Empty when it can be saved.
    public static IReadOnlyList<string> Problems(StationSettings s)
    {
        var problems = new List<string>();
        if (!IsValidApiUrl(s.ApiBaseUrl)) problems.Add("API-adressen skal være en webadresse, fx " + StationSettings.DefaultApiBaseUrl);

        foreach (var t in s.Stations.Where(t => string.IsNullOrWhiteSpace(t.Name)))
            problems.Add($"Station {t.Number} mangler et navn");

        foreach (var g in s.Stations.Where(t => !string.IsNullOrWhiteSpace(t.ScannerSerial))
                     .GroupBy(t => t.ScannerSerial!.Trim(), StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
            problems.Add($"Samme scanner er sat på {string.Join(" og ", g.Select(t => t.Name))}");

        return problems;
    }

    // One scanner belongs to one station: give it to this station and take it from any other.
    public static StationSettings AssignScanner(StationSettings s, int stationNumber, string? scannerId)
    {
        var id = string.IsNullOrWhiteSpace(scannerId) ? null : scannerId.Trim();
        return s with
        {
            Stations = [.. s.Stations.Select(t =>
                t.Number == stationNumber ? t with { ScannerSerial = id }
                : id is not null && string.Equals(t.ScannerSerial, id, StringComparison.OrdinalIgnoreCase) ? t with { ScannerSerial = null }
                : t)],
        };
    }
}
