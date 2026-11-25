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

    // ----- Arbejdsform

    // The Arbejdsformer the drop-down offers. Pakning comes with the packing checklist; until then a
    // station that has it (a newer app's file) keeps it and shows it, but it can't be picked.
    // Session is offered once its workflow is built (plan-scan-commands.md step 5); until then it would
    // be a choice that does nothing. A station already saved as Session still shows it.
    public static IReadOnlyList<StationWorkMode> OfferedWorkModes { get; } = [StationWorkMode.Enkel];

    public static string WorkModeLabel(StationWorkMode mode) => mode switch
    {
        StationWorkMode.Session => "Session (Start / Pause / Hold)",
        StationWorkMode.Pakning => "Pakning (tjekliste og paller)",
        _ => "Enkel (scan ind / scan ud)",
    };

    public const string SessionOneAtATime = "Session med Maks 1: ét element ad gangen";

    // A note on a station's Arbejdsform that doesn't stop a save, or null.
    public static string? WorkModeHint(StationSetup t) =>
        t is { WorkMode: StationWorkMode.Session, MaxActive: 1 } ? SessionOneAtATime : null;

    // The hints of every station, by station number. None stops a save.
    public static IReadOnlyDictionary<int, string> Hints(StationSettings s) =>
        s.Stations.Select(t => (t.Number, Hint: WorkModeHint(t))).Where(h => h.Hint is not null)
            .GroupBy(h => h.Number).ToDictionary(g => g.Key, g => g.First().Hint!);

    // What a changed Arbejdsform does to the elements on pause at a station: Gem ends them as a HOLD
    // would. Null when the Arbejdsform is the same or none are on pause. Doesn't stop a save.
    public static string? ModeChange(StationSetup before, StationSetup after, int paused)
    {
        if (before.WorkMode == after.WorkMode || paused <= 0) return null;
        var name = string.IsNullOrWhiteSpace(after.Name) ? $"Station {after.Number}" : after.Name.Trim();
        return paused == 1
            ? $"{name} har 1 element på pause. Det afsluttes, når du gemmer."
            : $"{name} har {paused} elementer på pause. De afsluttes, når du gemmer.";
    }

    // The warnings of every station whose Arbejdsform changes, by station number. pausedPerStation is
    // the number of elements on pause per station number (a station not listed has none).
    public static IReadOnlyDictionary<int, string> ModeChanges(StationSettings before, StationSettings after,
        IReadOnlyDictionary<int, int> pausedPerStation)
    {
        var old = before.Stations.GroupBy(t => t.Number).ToDictionary(g => g.Key, g => g.First());
        var warnings = new Dictionary<int, string>();
        foreach (var t in after.Stations)
            if (old.TryGetValue(t.Number, out var was) && !warnings.ContainsKey(t.Number)
                && ModeChange(was, t, pausedPerStation.GetValueOrDefault(t.Number)) is { } w)
                warnings[t.Number] = w;
        return warnings;
    }
}
