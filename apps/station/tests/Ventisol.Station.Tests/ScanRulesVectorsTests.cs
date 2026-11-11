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

    static IEnumerable<JsonElement> Cases => File.Value.GetProperty("cases").EnumerateArray();

    public static TheoryData<string> Names => [.. Cases.Select(c => c.GetProperty("name").GetString()!)];

    [Fact]
    public void There_are_vectors() => Assert.True(Cases.Count() >= 10);

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

        // No stations from settings: each one is taken from its scans, as the vectors give them.
        var r = ScanReplay.Replay(events, [], today);

        Assert.Equal(
            expected.GetProperty("done").EnumerateArray().Select(d => (d.GetProperty("barcode").GetString()!, d.GetProperty("stationNo").GetInt32(), Time(d, "start"), Time(d, "end")))
                .OrderBy(d => d.Item4).ThenBy(d => d.Item2).ThenBy(d => d.Item1, StringComparer.Ordinal),
            r.Done.Select(d => (d.Barcode.Raw, d.Station.Number, d.Start, d.End))
                .OrderBy(d => d.End).ThenBy(d => d.Number).ThenBy(d => d.Raw, StringComparer.Ordinal));

        Assert.Equal(
            expected.GetProperty("inProgress").EnumerateArray().Select(p => (p.GetProperty("stationNo").GetInt32(), p.GetProperty("barcode").GetString()!, Time(p, "since"))).OrderBy(p => p.Item1),
            r.InProgress.Select(p => (p.Key, p.Value.Barcode.Raw, p.Value.Since)).OrderBy(p => p.Key));

        // "packed" in the vectors is for the web report; the station shows no packed status.
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
            "VECTOR");
    }
}
