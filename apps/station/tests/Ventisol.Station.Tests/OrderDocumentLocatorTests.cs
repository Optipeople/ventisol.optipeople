using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Tests;

public sealed class OrderDocumentLocatorTests : IDisposable
{
    readonly string _root = Path.Combine(Path.GetTempPath(), "ventisol-docs-" + Guid.NewGuid().ToString("N"));

    public OrderDocumentLocatorTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    string Touch(string relative, DateTime? written = null)
    {
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "%PDF-1.4");
        if (written is { } w) File.SetLastWriteTimeUtc(path, w);
        return path;
    }

    sealed class ManualTime(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Theory]
    [InlineData("58721_20261022.pdf", 58721, "2026-10-22")]
    [InlineData("58721_20261022.PDF", 58721, "2026-10-22")]
    [InlineData("058721_20261022.pdf", 58721, "2026-10-22")]
    [InlineData("58721_20261022 (1).pdf", 58721, null)]
    [InlineData("58721_x.pdf", 58721, null)]
    public void File_names_give_order_and_date(string name, int order, string? date)
    {
        Assert.True(OrderDocumentLocator.TryParseFileName(name, out var o, out var d));
        Assert.Equal(order, o);
        Assert.Equal(date is null ? null : DateOnly.Parse(date), d);
    }

    [Theory]
    [InlineData("58721.pdf")]
    [InlineData("order_58721_20261022.pdf")]
    [InlineData("58721_20261022.txt")]
    public void Other_files_are_not_order_documents(string name) =>
        Assert.False(OrderDocumentLocator.TryParseFileName(name, out _, out _));

    [Fact]
    public async Task No_folder_is_off()
    {
        Assert.Equal(OrderDocumentStatus.Off, (await new OrderDocumentLocator(null).FindAsync(58721)).Status);
        Assert.Equal(OrderDocumentStatus.Off, (await new OrderDocumentLocator("  ").FindAsync(58721)).Status);
    }

    [Fact]
    public async Task The_newest_date_in_the_name_wins_then_the_newest_write_time_in_any_subfolder()
    {
        Touch("58721_20261022.pdf", new DateTime(2026, 11, 5, 0, 0, 0, DateTimeKind.Utc));
        var newest = Touch(@"2026\uge 45\58721_20261101.pdf", new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc));
        Touch(@"a\58800_20261022.pdf", new DateTime(2026, 10, 22, 8, 0, 0, DateTimeKind.Utc));
        var later = Touch(@"b\58800_20261022.pdf", new DateTime(2026, 10, 22, 9, 0, 0, DateTimeKind.Utc));
        Touch("notes.txt");

        var locator = new OrderDocumentLocator(_root);

        Assert.Equal(new OrderDocumentLookup(58721, OrderDocumentStatus.Found, newest), await locator.FindAsync(58721));
        Assert.Equal(later, (await locator.FindAsync(58800)).Path);
        Assert.Equal(OrderDocumentStatus.NotFound, (await locator.FindAsync(12345)).Status);
        Assert.Equal(2, locator.IndexedOrders);
    }

    [Fact]
    public async Task A_missing_folder_is_unavailable()
    {
        var locator = new OrderDocumentLocator(Path.Combine(_root, "not-there"));
        var r = await locator.FindAsync(58721);
        Assert.Equal(OrderDocumentStatus.FolderUnavailable, r.Status);
        Assert.Equal("Mappen findes ikke", r.Error);

        var status = await OrderDocumentLocator.CheckFolderAsync(Path.Combine(_root, "not-there"));
        Assert.False(status.Available);
    }

    [Fact]
    public async Task The_index_is_kept_for_30_seconds_and_a_miss_lists_again()
    {
        var time = new ManualTime(new DateTimeOffset(2026, 11, 10, 8, 0, 0, TimeSpan.Zero));
        var files = new List<OrderDocumentLocator.Entry> { new(@"R:\58721_20261022.pdf", 58721, new DateOnly(2026, 10, 22), default) };
        var listings = 0;
        var locator = new OrderDocumentLocator(@"R:\", time, (_, _) => { listings++; return [.. files]; });

        Assert.Equal(OrderDocumentStatus.Found, (await locator.FindAsync(58721)).Status);
        time.Now += TimeSpan.FromSeconds(10);
        Assert.Equal(OrderDocumentStatus.Found, (await locator.FindAsync(58721)).Status);
        Assert.Equal(1, listings);

        // A new order: the index doesn't have it, so the folder is listed again and it is found.
        files.Add(new(@"R:\58800_20261022.pdf", 58800, new DateOnly(2026, 10, 22), default));
        Assert.Equal(OrderDocumentStatus.Found, (await locator.FindAsync(58800)).Status);
        Assert.Equal(2, listings);

        // Misses right after a listing don't list again.
        Assert.Equal(OrderDocumentStatus.NotFound, (await locator.FindAsync(1)).Status);
        Assert.Equal(OrderDocumentStatus.NotFound, (await locator.FindAsync(2)).Status);
        Assert.Equal(2, listings);

        // After 30 s even a hit lists again, and sees a newer file.
        files.Add(new(@"R:\58721_20261105.pdf", 58721, new DateOnly(2026, 11, 5), default));
        time.Now += TimeSpan.FromSeconds(31);
        Assert.Equal(@"R:\58721_20261105.pdf", (await locator.FindAsync(58721)).Path);
        Assert.Equal(3, listings);
    }

    [Fact]
    public async Task A_slow_share_answers_in_time_and_fills_the_index_later()
    {
        using var gate = new ManualResetEventSlim(false);
        var listings = 0;
        var locator = new OrderDocumentLocator(@"R:\", list: (_, _) =>
        {
            Interlocked.Increment(ref listings);
            gate.Wait(TimeSpan.FromSeconds(10));
            return [new(@"R:\58721_20261022.pdf", 58721, new DateOnly(2026, 10, 22), default)];
        }) { Timeout = TimeSpan.FromMilliseconds(100) };

        var started = DateTime.UtcNow;
        var first = await Task.WhenAll(locator.FindAsync(58721), locator.FindAsync(58721));
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(5));
        Assert.All(first, r => Assert.Equal(OrderDocumentStatus.FolderUnavailable, r.Status));
        Assert.Equal("Mappen svarer ikke", first[0].Error);
        Assert.Equal(1, listings);

        gate.Set();
        var found = await locator.FindAsync(58721);
        Assert.Equal(OrderDocumentStatus.Found, found.Status);
        Assert.Equal(1, listings);
    }

    [Fact]
    public async Task A_stale_index_answers_while_the_share_is_slow()
    {
        var time = new ManualTime(DateTimeOffset.UnixEpoch);
        var slow = false;
        using var gate = new ManualResetEventSlim(false);
        var locator = new OrderDocumentLocator(@"R:\", time, (_, _) =>
        {
            if (slow) gate.Wait(TimeSpan.FromSeconds(10));
            return [new(@"R:\58721_20261022.pdf", 58721, null, default)];
        }) { Timeout = TimeSpan.FromMilliseconds(100) };

        Assert.Equal(OrderDocumentStatus.Found, (await locator.FindAsync(58721)).Status);
        slow = true;
        time.Now += TimeSpan.FromMinutes(5);
        Assert.Equal(OrderDocumentStatus.Found, (await locator.FindAsync(58721)).Status);
        Assert.Equal(OrderDocumentStatus.FolderUnavailable, (await locator.FindAsync(1)).Status);
        gate.Set();
    }

    [Fact]
    public async Task The_folder_check_counts_orders()
    {
        Touch("58721_20261022.pdf");
        Touch("58721_20261101.pdf");
        Touch(@"sub\58800_20261022.pdf");

        var status = await OrderDocumentLocator.CheckFolderAsync(_root);

        Assert.Equal(new OrderDocumentFolderStatus(true, 2, 3), status);
    }

    [SamplesFact]
    public async Task The_sample_folder_has_26_orders()
    {
        var locator = new OrderDocumentLocator(OrderDocSamples.Folder);
        Assert.Equal(26, (await locator.RefreshAsync()).Orders);
        var r = await locator.FindAsync(58721);
        Assert.Equal(OrderDocumentStatus.Found, r.Status);
        Assert.Equal(58721, OrderDocumentParser.Parse(r.Path!).Header.OrderNumber);
    }
}

public class DocumentsFolderSettingTests
{
    [Fact]
    public void The_documents_folder_survives_a_round_trip_and_is_off_by_default()
    {
        Assert.Null(StationSettings.Default.DocumentsFolder);
        var s = StationSettings.Default with { DocumentsFolder = @"R:\Indkøb\Shares\Ordre" };
        var back = StationSettingsJson.Deserialize(StationSettingsJson.Serialize(s));
        Assert.Equal(@"R:\Indkøb\Shares\Ordre", back!.DocumentsFolder);
    }

    [Fact]
    public void An_older_file_without_it_has_it_off()
    {
        var back = StationSettingsJson.Deserialize("""{ "version": 1, "mode": "Scan" }""");
        Assert.Null(back!.DocumentsFolder);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("   ", null)]
    [InlineData(@" ""R:\Indkøb\Shares\Ordre"" ", @"R:\Indkøb\Shares\Ordre")]
    [InlineData(@"R:\Indkøb\Shares\Ordre\", @"R:\Indkøb\Shares\Ordre")]
    [InlineData(@"R:\", @"R:\")]
    [InlineData("R:", @"R:\")]
    [InlineData(@"\\server\share\Ordre\", @"\\server\share\Ordre")]
    public void The_folder_is_normalised(string? typed, string? kept)
    {
        Assert.Equal(kept, StationSettingsJson.NormalizeFolder(typed));
        Assert.Equal(kept, StationSettingsJson.Normalize(StationSettings.Default with { DocumentsFolder = typed }).DocumentsFolder);
    }
}
