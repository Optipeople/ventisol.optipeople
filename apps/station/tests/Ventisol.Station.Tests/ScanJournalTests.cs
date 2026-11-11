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

    [Fact]
    public void An_old_day_with_a_scan_still_waiting_is_kept()
    {
        var journal = new ScanJournal(_folder);
        var waiting = In("058556050103", 1, Noon.AddDays(-5));
        journal.Append(waiting);
        journal.Append(In("058556050102", 2, Noon.AddDays(-4)));

        journal.Prune(Noon, [waiting.ScanId]);

        Assert.Equal([$"{Noon.AddDays(-5):yyyy-MM-dd}.jsonl"], Directory.GetFiles(_folder).Select(Path.GetFileName));
        Assert.Equal(waiting, journal.Find(waiting.ScanId));
    }

    [Fact]
    public void A_scan_is_found_by_its_ScanId_on_any_day_kept()
    {
        var journal = new ScanJournal(_folder);
        var yesterday = In("058556050103", 1, Noon.AddDays(-1));
        var today = Out("058556050103", 1, Noon);
        journal.Append(yesterday);
        journal.Append(today);

        Assert.Equal(yesterday, new ScanJournal(_folder).Find(yesterday.ScanId));
        Assert.Equal(today, new ScanJournal(_folder).Find(today.ScanId));
        Assert.Null(new ScanJournal(_folder).Find(Guid.NewGuid()));
        Assert.Null(new ScanJournal(Path.Combine(_folder, "none")).Find(today.ScanId));
    }

    [Fact]
    public void Days_long_before_since_are_not_opened()
    {
        var journal = new ScanJournal(_folder);
        var recent = In("058556050103", 1, Noon.AddHours(-1));
        journal.Append(recent);
        // A day kept for the outbox's sake. A line of now in it shows whether it was read.
        var stray = Out("058556050103", 1, Noon);
        journal.Append(stray);
        var today = Path.Combine(_folder, $"{Noon:yyyy-MM-dd}.jsonl");
        var lines = File.ReadAllLines(today);
        File.WriteAllLines(today, lines[..1]);
        File.WriteAllLines(Path.Combine(_folder, $"{Noon.AddDays(-5):yyyy-MM-dd}.jsonl"), lines[1..]);

        Assert.Equal([recent], journal.ReadSince(Noon.AddHours(-3)));
        // Since far enough back, it is read; and Find still looks in every day.
        Assert.Equal([recent, stray], journal.ReadSince(Noon.AddDays(-5)));
        Assert.Equal(stray, journal.Find(stray.ScanId));
    }

    [Fact]
    public void The_day_before_since_is_still_read()
    {
        var journal = new ScanJournal(_folder);
        var late = In("058556050103", 1, Noon.AddHours(-13));
        journal.Append(late);

        Assert.Equal([late], journal.ReadSince(Noon.AddHours(-14)));
        Assert.Equal([late], journal.ReadSince(DateTimeOffset.MinValue));
    }
}
