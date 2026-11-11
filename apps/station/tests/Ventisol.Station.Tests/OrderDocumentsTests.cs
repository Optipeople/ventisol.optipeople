using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Writer;

namespace Ventisol.Station.Tests;

public sealed class OrderDocumentsTests : IDisposable
{
    readonly string _root = Path.Combine(Path.GetTempPath(), "ventisol-docload-" + Guid.NewGuid().ToString("N"));

    public OrderDocumentsTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    [Fact]
    public async Task No_folder_is_off()
    {
        var docs = new OrderDocuments(new OrderDocumentLocator(null));
        Assert.False(docs.IsOn);
        Assert.Equal(OrderDocumentLoadStatus.Off, (await docs.LoadAsync(Code("058721010101"))).Status);
    }

    [Fact]
    public async Task A_missing_folder_is_unavailable_and_a_missing_order_not_found()
    {
        var gone = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "nope")));
        Assert.Equal(OrderDocumentLoadStatus.FolderUnavailable, (await gone.LoadAsync(Code("058721010101"))).Status);

        var empty = new OrderDocuments(new OrderDocumentLocator(_root));
        Assert.Equal(OrderDocumentLoadStatus.NotFound, (await empty.LoadAsync(Code("058721010101"))).Status);
    }

    [Fact]
    public async Task A_file_that_is_not_a_pdf_is_unreadable()
    {
        File.WriteAllText(Path.Combine(_root, "58721_20261022.pdf"), "not a pdf");
        var docs = new OrderDocuments(new OrderDocumentLocator(_root));
        var load = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Unreadable, load.Status);
    }

    [Fact]
    public async Task A_slow_file_answers_unreadable_in_time_and_fills_the_cache_for_the_next_look()
    {
        File.WriteAllText(Path.Combine(_root, "58721_20261022.pdf"), "x");
        var gate = new ManualResetEventSlim();
        var docs = new OrderDocuments(new OrderDocumentLocator(_root), _ => { gate.Wait(); return [1, 2, 3]; })
        {
            ReadTimeout = TimeSpan.FromMilliseconds(100),
        };
        var slow = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Unreadable, slow.Status);
        Assert.Equal("Filen svarer ikke", slow.Error);
        gate.Set();
    }

    [SamplesFact]
    public async Task A_sample_loads_with_its_position_and_bytes_and_the_second_load_is_the_cached_one()
    {
        var reads = 0;
        var docs = new OrderDocuments(new OrderDocumentLocator(OrderDocSamples.Folder), p => { Interlocked.Increment(ref reads); return File.ReadAllBytes(p); });
        var first = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, first.Status);
        Assert.Equal(1, first.Position!.Number);
        Assert.NotNull(first.Pdf);
        Assert.NotNull(first.FileKey);

        var second = await docs.LoadAsync(Code("058721010102"));
        Assert.Same(first.Document, second.Document);
        Assert.Equal(1, reads);

        var missing = await docs.LoadAsync(Code("058721990101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, missing.Status);
        Assert.Null(missing.Position);
    }

    [SamplesFact]
    public void The_sheet_shows_a_sample_position_as_printed()
    {
        var doc = OrderDocSamples.Parse(58721);
        var barcode = Code("058721010101");
        var sheet = ElementSheet.For(barcode, doc, doc.PositionFor(barcode));

        Assert.Equal("58721", sheet.Order);
        Assert.Equal("1", sheet.Position);
        Assert.Equal("1 af 1", sheet.Piece);
        Assert.Equal("Jens Andersen", sheet.Customer);
        Assert.Equal("46", sheet.DeliveryWeek);
        Assert.Equal("SOFTLINE", sheet.System);
        Assert.Contains(sheet.Facts, f => f.Label == "Mål u/kobling" && f.Value == "1485 × 1380");
        Assert.Contains(sheet.Facts, f => f.Label == "Vægt" && f.Value == "84,5 kg");
        Assert.Contains(sheet.Facts, f => f.Label == "Karmhuller" && f.Value == "d=6,5 ve/hø");

        var field = Assert.Single(sheet.Fields);
        Assert.Equal("Drej Kip V.I.", field.Opening);
        Assert.Equal("1415,0 × 1310,0", field.FrameSize);
        Assert.Equal("1 stk.  ·  1283 × 1178  ·  107.208_G", Assert.Single(field.Panes));

        // Sections become headings over their rows; the columns nobody uses are hidden.
        Assert.Equal(["Karm", "Ramme"], sheet.Cutting.Rows.Where(r => r.IsHeading).Select(r => r.Profile));
        Assert.True(sheet.Cutting.ShowSteel);
        Assert.False(sheet.Cutting.ShowWidth);
        Assert.Equal("Beslag", sheet.Parts.Rows[0].Description);
        Assert.True(sheet.Parts.Rows[0].IsHeading);
    }

    // A one-page PDF with nothing on it: readable, so it can be kept and shown.
    static byte[] BlankPdf()
    {
        var builder = new PdfDocumentBuilder();
        builder.AddPage(PageSize.A4);
        return builder.Build();
    }

    string Share(string name)
    {
        var dir = Path.Combine(_root, "share");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        File.WriteAllBytes(path, BlankPdf());
        return path;
    }

    [Fact]
    public async Task A_document_read_before_answers_from_memory_as_a_copy_while_the_share_is_gone()
    {
        Share("BE_58721_20261022.pdf");
        var docs = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "share")) { RefreshAfter = TimeSpan.Zero });
        var first = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, first.Status);
        Assert.False(first.FromCopy);

        Directory.Delete(Path.Combine(_root, "share"), recursive: true);
        var copy = await docs.LoadAsync(Code("058721010102"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, copy.Status);
        Assert.True(copy.FromCopy);
        Assert.Same(first.Document, copy.Document);
        Assert.True(docs.Has(58721));
    }

    [Fact]
    public async Task A_copy_on_this_pc_answers_when_the_share_is_gone_even_after_a_restart()
    {
        Share("BE_58721_20261022.pdf");
        var cache = new OrderDocumentCache(Path.Combine(_root, "cache"));
        var before = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "share")), cache: cache);
        Assert.Equal(OrderDocumentLoadStatus.Ready, (await before.LoadAsync(Code("058721010101"))).Status);
        Assert.True(File.Exists(Path.Combine(_root, "cache", "BE_58721_20261022.pdf")));

        Directory.Delete(Path.Combine(_root, "share"), recursive: true);
        var after = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "share")), cache: cache);
        var load = await after.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.True(load.FromCopy);
        Assert.Equal(1, load.Document!.PageCount);

        // An order never read before has no copy: the folder is still unavailable.
        Assert.Equal(OrderDocumentLoadStatus.FolderUnavailable, (await after.LoadAsync(Code("058800010101"))).Status);
    }

    [Fact]
    public async Task When_the_share_answers_the_share_wins_over_an_older_copy()
    {
        var cacheDir = Path.Combine(_root, "cache");
        Directory.CreateDirectory(cacheDir);
        File.WriteAllBytes(Path.Combine(cacheDir, "58721_20261001.pdf"), BlankPdf());
        var newest = Share("TE_58721_20261105.pdf");

        var docs = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "share")), cache: new OrderDocumentCache(cacheDir));
        var load = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.False(load.FromCopy);
        Assert.Equal(newest, load.Path);
        // And the copy on this PC is the newest one now.
        Assert.Equal(Path.Combine(cacheDir, "TE_58721_20261105.pdf"), new OrderDocumentCache(cacheDir).Find(58721));
    }

    [Fact]
    public void Copies_not_saved_for_a_week_go_and_only_the_newest_200_are_kept()
    {
        var dir = Path.Combine(_root, "cache");
        Directory.CreateDirectory(dir);
        var now = DateTime.UtcNow;
        for (var i = 0; i < 205; i++)
        {
            var path = Path.Combine(dir, $"{60000 + i}_20261022.pdf");
            File.WriteAllBytes(path, [1]);
            File.SetLastWriteTimeUtc(path, now.AddMinutes(-i));
        }
        var old = Path.Combine(dir, "50000_20261022.pdf");
        File.WriteAllBytes(old, [1]);
        File.SetLastWriteTimeUtc(old, now.AddDays(-8));

        new OrderDocumentCache(dir).Prune();

        Assert.Equal(OrderDocumentCache.MaxFiles, Directory.GetFiles(dir).Length);
        Assert.False(File.Exists(old));
        Assert.True(File.Exists(Path.Combine(dir, "60000_20261022.pdf")));
        Assert.False(File.Exists(Path.Combine(dir, "60204_20261022.pdf")));
    }

    [Fact]
    public void The_copy_for_an_order_is_the_named_file_else_the_newest_date()
    {
        var dir = Path.Combine(_root, "cache");
        Directory.CreateDirectory(dir);
        foreach (var name in new[] { "58721_20261001.pdf", "BE_58721_20261105.pdf", "58800_20261201.pdf" })
            File.WriteAllBytes(Path.Combine(dir, name), [1]);
        var cache = new OrderDocumentCache(dir);

        Assert.Equal(Path.Combine(dir, "BE_58721_20261105.pdf"), cache.Find(58721));
        Assert.Equal(Path.Combine(dir, "58721_20261001.pdf"), cache.Find(58721, @"R:\x\58721_20261001.pdf"));
        Assert.Null(cache.Find(12345));
        Assert.Null(new OrderDocumentCache(Path.Combine(_root, "nope")).Find(58721));
    }

    [Fact]
    public void Without_a_document_the_sheet_has_the_barcode_only()
    {
        var sheet = ElementSheet.For(Code("058556050203"));
        Assert.Equal("58556", sheet.Order);
        Assert.Equal("5.1", sheet.Position);
        Assert.Equal("3", sheet.Piece);
        Assert.Null(sheet.Customer);
        Assert.Empty(sheet.Facts);
        Assert.Empty(sheet.Cutting.Rows);
    }
}
