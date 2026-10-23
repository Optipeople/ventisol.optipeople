using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class ScanJournalTests : IDisposable
{
    static readonly DateTimeOffset Noon = new(DateTime.Today.AddHours(12));
    readonly string _folder = TempFolder();

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void Scans_come_back_oldest_first_from_since_on_in_a_file_per_day()
    {
        var journal = new ScanJournal(_folder);
        var yesterday = In("058556050103", 1, Noon.AddDays(-1));
        var a = Out("058556050103", 1, Noon.AddHours(-1));
        var b = In("058556050102", 2, Noon.AddHours(-2));
        journal.Append(yesterday);
        journal.Append(a);
        journal.Append(b);

        Assert.Equal([b, a], new ScanJournal(_folder).ReadSince(Noon.AddHours(-3)));
        Assert.Equal([yesterday, b, a], new ScanJournal(_folder).ReadSince(Noon.AddDays(-2)));
        Assert.Equal([$"{Noon.AddDays(-1):yyyy-MM-dd}.jsonl", $"{Noon:yyyy-MM-dd}.jsonl"], Directory.GetFiles(_folder).Select(Path.GetFileName).Order());
    }

    [Fact]
    public void A_line_cut_off_by_a_crash_loses_only_that_scan()
    {
        var journal = new ScanJournal(_folder);
        var a = In("058556050103", 1, Noon);
        journal.Append(a);
        File.AppendAllText(Path.Combine(_folder, $"{Noon:yyyy-MM-dd}.jsonl"), "{\"scanId\":\"half");
        var b = Out("058556050103", 1, Noon.AddMinutes(1));
        journal.Append(b);

        Assert.Equal([a, b], journal.ReadSince(Noon.AddHours(-1)));
    }

    [Fact]
    public void Only_the_last_three_days_are_kept()
    {
        var journal = new ScanJournal(_folder);
        for (var d = 0; d < 5; d++) journal.Append(In("058556050103", 1, Noon.AddDays(-d)));
        File.WriteAllText(Path.Combine(_folder, "notes.jsonl"), "");

        journal.Prune(Noon);

        Assert.Equal(
            [$"{Noon.AddDays(-2):yyyy-MM-dd}.jsonl", $"{Noon.AddDays(-1):yyyy-MM-dd}.jsonl", $"{Noon:yyyy-MM-dd}.jsonl", "notes.jsonl"],
            Directory.GetFiles(_folder).Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }
}
