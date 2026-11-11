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

    // An https address. Plain http sends the password and the tokens for anyone on the network to
    // read, so it is taken only for this PC itself (localhost, 127.0.0.1): the FakeOptiCloud dev tool.
    public static bool IsValidApiUrl(string? text) => ApiUrlProblem(text) is null;

    public const string NotAnAddress = "API-adressen er ikke en webadresse";
    public const string HttpsOnly = "API-adressen skal begynde med https://";

    // What is wrong with the API address (NotAnAddress or HttpsOnly); null when it is fine.
    public static string? ApiUrlProblem(string? text)
    {
        if (!Uri.TryCreate(text?.Trim(), UriKind.Absolute, out var u) || string.IsNullOrEmpty(u.Host)) return NotAnAddress;
        if (u.Scheme == Uri.UriSchemeHttps) return null;
        if (u.Scheme != Uri.UriSchemeHttp) return NotAnAddress;
        return u.Host is "localhost" or "127.0.0.1" ? null : HttpsOnly;
    }

    // Everything that stops a save, in the order the screen shows it. Empty when it can be saved.
    public static IReadOnlyList<string> Problems(StationSettings s)
    {
        var problems = new List<string>();
        if (ApiUrlProblem(s.ApiBaseUrl) is { } url)
            problems.Add(url == HttpsOnly ? url : "API-adressen skal være en webadresse, fx " + StationSettings.DefaultApiBaseUrl);

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
