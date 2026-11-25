using System.Globalization;
using System.Text.Json;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Tests;

// docs/scan-rules-vectors.json, the cases the reports site runs too. Its _doc says how to run one.
public class ScanRulesVectorsTests
{
    static readonly Lazy<JsonElement> File = new(() =>
        JsonDocument.Parse(System.IO.File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "scan-rules-vectors.json"))).RootElement.Clone());

    static IEnumerable<JsonElement> AllCases => File.Value.GetProperty("cases").EnumerateArray();

    // A case tagged "needs" waits for a rule not built yet (see the file's _doc): "events" for Session
    // (Event, Mark, pause chains), "shift-end" for the stop at shift end. It is left out here until
    // the step that builds it adds the tag to this list.
    static readonly string[] Built = ["shift-end"];

    static readonly string[] Known = ["events", "shift-end"];

    static string? Needs(JsonElement c) => c.TryGetProperty("needs", out var n) ? n.GetString() : null;

    static IEnumerable<JsonElement> Cases => AllCases.Where(c => Needs(c) is not { } n || Built.Contains(n));

    public static TheoryData<string> Names => [.. Cases.Select(c => c.GetProperty("name").GetString()!)];

    [Fact]
    public void There_are_vectors() => Assert.True(Cases.Count() >= 14);

    [Fact]
    public void Cases_waiting_for_a_rule_are_tagged_with_a_known_need()
    {
        Assert.All(AllCases.Where(c => Needs(c) is not null), c => Assert.Contains(Needs(c), Known));
        Assert.Equal(AllCases.Count(), AllCases.Select(c => c.GetProperty("name").GetString()).Distinct().Count());
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void The_station_follows_the_rule(string name)
    {
        var c = Cases.Single(x => x.GetProperty("name").GetString() == name);
        var now = Time(c, "now");
        var today = Time(c, "todayStart");
        var window = Time(c, "windowStart");
        var events = c.GetProperty("events").EnumerateArray().Select(Event).Where(e => e.At >= window).ToList();
        var expected = c.GetProperty("expected");

        // No stations from settings: each one is taken from its scans, as the vectors give them, and
        // its "Max i gang" from the case's maxOpen (a station not listed has 1).
        var maxOpen = c.TryGetProperty("maxOpen", out var m)
            ? m.EnumerateObject().ToDictionary(p => int.Parse(p.Name, CultureInfo.InvariantCulture), p => p.Value.GetInt32())
            : [];
        var r = ScanReplay.Replay(events, [], today, maxOpen);

        // endEvent: missing means Scan. activeSec, when given, is the record's time (no chains yet).
        var expectedDone = expected.GetProperty("done").EnumerateArray()
            .Select(d => (d.GetProperty("barcode").GetString()!, d.GetProperty("stationNo").GetInt32(), Time(d, "start"), Time(d, "end"),
                d.TryGetProperty("endEvent", out var ev) ? Enum.Parse<ScanEventKind>(ev.GetString()!) : ScanEventKind.Scan))
            .OrderBy(d => d.Item4).ThenBy(d => d.Item2).ThenBy(d => d.Item1, StringComparer.Ordinal).ToList();
        var actualDone = r.Done.Select(d => (d.Barcode.Raw, d.Station.Number, d.Start, d.End, d.EndEvent))
            .OrderBy(d => d.End).ThenBy(d => d.Number).ThenBy(d => d.Raw, StringComparer.Ordinal).ToList();
        Assert.Equal(expectedDone, actualDone);
        foreach (var (d, i) in expected.GetProperty("done").EnumerateArray()
            .OrderBy(d => Time(d, "end")).ThenBy(d => d.GetProperty("stationNo").GetInt32()).ThenBy(d => d.GetProperty("barcode").GetString(), StringComparer.Ordinal)
            .Select((d, i) => (d, i)))
            if (d.TryGetProperty("activeSec", out var active))
                Assert.Equal(active.GetInt32(), (int)actualDone[i].Item4.Subtract(actualDone[i].Item3).TotalSeconds);

        // Paused elements are a Session rule: no case run here may expect one.
        if (expected.TryGetProperty("paused", out var paused)) Assert.Empty(paused.EnumerateArray());

        Assert.Equal(
            expected.GetProperty("inProgress").EnumerateArray().Select(p => (p.GetProperty("stationNo").GetInt32(), p.GetProperty("barcode").GetString()!, Time(p, "since")))
                .OrderBy(p => p.Item1).ThenBy(p => p.Item3).ThenBy(p => p.Item2, StringComparer.Ordinal),
            r.InProgress.SelectMany(p => p.Value.Select(a => (p.Key, a.Barcode.Raw, a.Since)))
                .OrderBy(p => p.Key).ThenBy(p => p.Since).ThenBy(p => p.Raw, StringComparer.Ordinal));

    }

    static DateTimeOffset Time(JsonElement e, string name) =>
        DateTimeOffset.Parse(e.GetProperty(name).GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

    static ScanEvent Event(JsonElement e)
    {
        Assert.True(Barcode.TryParse(e.GetProperty("barcode").GetString(), out var barcode));
        var duration = e.GetProperty("durationSec");
        return new ScanEvent(
            Guid.Parse(e.GetProperty("id").GetString()!),
            barcode,
            e.GetProperty("stationNo").GetInt32(),
            e.GetProperty("station").GetString()!,
            Enum.Parse<StationKind>(e.GetProperty("stationKind").GetString()!),
            null,
            Enum.Parse<ScanDirection>(e.GetProperty("direction").GetString()!),
            Time(e, "time"),
            duration.ValueKind == JsonValueKind.Null ? null : duration.GetInt32(),
            "VECTOR",
            e.TryGetProperty("event", out var ev) ? Enum.Parse<ScanEventKind>(ev.GetString()!) : ScanEventKind.Scan);
    }
}
