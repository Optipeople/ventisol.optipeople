using System.Net;
using System.Text.Json.Nodes;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Tests;

// The order's BS drawings ("58931_20261127BS tegninger.pdf"): which page draws which position, and how
// they come along with the element's document from the share and from OptiCloud. The PDFs are made
// here, laid out like the real ones: "Position : 2" on a drawings page, "Position:  2" in a list.
public sealed class BsDrawingsTests : IDisposable
{
    readonly string _root = TestScans.TempFolder();

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    // A drawings PDF with a page per entry: the position printed on it as the real file does, or
    // (null) a page that names none.
    static byte[] Drawings(params int?[] positions)
    {
        var b = new PdfDocumentBuilder();
        var regular = b.AddStandard14Font(Standard14Font.Helvetica);
        var bold = b.AddStandard14Font(Standard14Font.HelveticaBold);
        foreach (var position in positions)
        {
            var page = b.AddPage(839, 592);
            page.AddText("Produktions tegning", 15.6, new PdfPoint(42.5, 534.3), bold);
            page.AddText("Ordrer nr.:", 9.7, new PdfPoint(42.5, 520.6), regular);
            page.AddText("58931", 9.7, new PdfPoint(91, 520.6), bold);
            if (position is { } n)
            {
                page.AddText($"Position : {n}", 12, new PdfPoint(42.5, 495), bold);
                page.AddText("Elementmaal: 890,0 mm * 1655,0 mm", 12, new PdfPoint(156, 495), regular);
            }
            page.DrawLine(new PdfPoint(42.5, 160), new PdfPoint(210, 160));
            page.DrawLine(new PdfPoint(42.5, 160), new PdfPoint(42.5, 470));
            page.AddText("445,0", 8, new PdfPoint(70, 140), regular);
        }
        return b.Build();
    }

    // A production list with a page per position, as much of one as the parser needs to find them.
    static byte[] List(params int[] positions)
    {
        var b = new PdfDocumentBuilder();
        var regular = b.AddStandard14Font(Standard14Font.Helvetica);
        var bold = b.AddStandard14Font(Standard14Font.HelveticaBold);
        foreach (var position in positions)
        {
            var page = b.AddPage(839, 592);
            page.AddText("Produktionsliste", 15.6, new PdfPoint(42.5, 534.3), bold);
            page.AddText("Ordrer nr.:", 9.7, new PdfPoint(42.5, 520.6), regular);
            page.AddText("58931", 9.7, new PdfPoint(91, 520.6), bold);
            page.AddText(new string('_', 120), 9.7, new PdfPoint(39.5, 465.7), regular);
            page.AddText("System", 9.7, new PdfPoint(34.2, 443.8), regular);
            page.AddText("SOFTLINE", 9.7, new PdfPoint(99.2, 443.8), bold);
            page.AddText("Position:", 9.7, new PdfPoint(34.2, 424), regular);
            page.AddText(position.ToString(), 9.7, new PdfPoint(99.2, 424), bold);
        }
        return b.Build();
    }

    string Put(string name, byte[] pdf, DateTime? written = null)
    {
        var dir = Path.Combine(_root, "share");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        File.WriteAllBytes(path, pdf);
        if (written is { } at) File.SetLastWriteTimeUtc(path, at);
        return path;
    }

    OrderDocuments Share(OrderDocumentCache? cache = null) =>
        new(new OrderDocumentLocator(Path.Combine(_root, "share")) { RefreshAfter = TimeSpan.Zero }, cache: cache);

    // ---- The pages

    [Fact]
    public void Each_page_gives_the_position_printed_on_it()
    {
        var pages = OrderDocumentParser.DrawingPages(Drawings(2, null, 14));

        Assert.Equal([2, null, 14], pages.Select(p => p.Position));
        Assert.All(pages, p => Assert.Equal((839, 592), (p.Width, p.Height)));
    }

    [Fact]
    public void The_position_is_read_however_the_label_is_spaced_or_cased()
    {
        foreach (var label in new[] { "Position : 7", "Position: 7", "Position :7", "POSITION  :  7", "Position:7" })
        {
            var b = new PdfDocumentBuilder();
            b.AddPage(839, 592).AddText(label, 12, new PdfPoint(42.5, 495), b.AddStandard14Font(Standard14Font.HelveticaBold));
            Assert.Equal(7, Assert.Single(OrderDocumentParser.DrawingPages(b.Build())).Position);
        }
    }

    [Fact]
    public void A_page_knows_the_part_of_it_that_is_drawn_on()
    {
        var content = Assert.Single(OrderDocumentParser.DrawingPages(Drawings(2))).Content;

        Assert.NotNull(content);
        // The drawing sits at the left of the sheet: the box holds it and its texts, and not the empty right half.
        Assert.True(content.Left < 42.5 && content.Bottom < 140 && content.Top > 545, $"{content}");
        Assert.True(content.Right > 330 && content.Right < 450, $"{content}");
        Assert.Equal((839, 592), (content.PageWidth, content.PageHeight));
    }

    [Fact]
    public void An_empty_page_has_no_content_and_a_file_that_is_no_pdf_has_no_pages()
    {
        var b = new PdfDocumentBuilder();
        b.AddPage(839, 592);
        var blank = Assert.Single(OrderDocumentParser.DrawingPages(b.Build()));
        Assert.Null(blank.Position);
        Assert.Null(blank.Content);

        Assert.Empty(OrderDocumentParser.DrawingPages([1, 2, 3]));
        Assert.Empty(OrderDocumentParser.DrawingPages([]));
    }

    [Fact]
    public void The_page_for_a_position_is_the_first_that_names_it()
    {
        var drawings = new BsDrawings([], "x.pdf", "key", [new(2, 839, 592), new(null, 839, 592), new(5, 839, 592), new(5, 839, 592)], FromCopy: false);

        Assert.Equal(0, drawings.PageFor(2));
        Assert.Equal(2, drawings.PageFor(5));
        Assert.Null(drawings.PageFor(3));
        Assert.True(drawings.NamesPositions);
        Assert.False(new BsDrawings([], "x.pdf", "key", [new(null, 839, 592)], false).NamesPositions);
    }

    // ---- From the share

    [Theory]
    [InlineData("58931_20261127.pdf", "58931_20261127BS.pdf", "58931_20261127BS tegninger.pdf", "058931")]
    [InlineData("58931_20261112.pdf", "B S 58931_20261112.pdf", "B S tegninger 58931_20261112.pdf", "058931")]
    [InlineData("2634_20261112.pdf", "2634_20261112BS.pdf", "2634_20261112BS tegninger.pdf", "002634")]
    [InlineData("BE_2634_20261112.pdf", "BE_2634_20261112BS.pdf", "BE_2634_20261112BS_tegninger.pdf", "002634")]
    public async Task An_element_from_the_BS_list_gets_the_drawings_at_its_page(string list, string bsList, string drawings, string order)
    {
        Put(list, List(1, 3));
        var bsPath = Put(bsList, List(2, 4));
        var drawingsPath = Put(drawings, Drawings(2, 4));
        var docs = Share();

        var load = await docs.LoadAsync(Code(order + "040101"));

        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.Equal(bsPath, load.Path);
        Assert.Equal(OrderDocumentKind.BsList, load.Kind);
        Assert.Equal(4, load.Position!.Number);
        Assert.NotNull(load.BsDrawings);
        Assert.Equal(drawingsPath, load.BsDrawings.Path);
        Assert.Equal(File.ReadAllBytes(drawingsPath), load.BsDrawings.Pdf);
        Assert.Equal([2, 4], load.BsDrawings.Pages.Select(p => p.Position));
        Assert.False(load.BsDrawings.FromCopy);
        Assert.Equal(1, load.BsDrawingsPage);

        Assert.Equal(0, (await docs.LoadAsync(Code(order + "020101"))).BsDrawingsPage);
    }

    [Fact]
    public async Task An_element_the_drawings_do_not_draw_is_not_offered_them()
    {
        Put("58931_20261127.pdf", List(1, 3));
        Put("58931_20261127BS.pdf", List(2));
        Put("58931_20261127BS tegninger.pdf", Drawings(2));
        var docs = Share();

        var ordinary = await docs.LoadAsync(Code("058931010101"));
        Assert.Equal(OrderDocumentKind.List, ordinary.Kind);
        Assert.Equal(1, ordinary.Position!.Number);
        // The file is there, and it says it is about position 2 only.
        Assert.NotNull(ordinary.BsDrawings);
        Assert.Null(ordinary.BsDrawingsPage);

        // In no list at all: the same.
        var nowhere = await docs.LoadAsync(Code("058931090101"));
        Assert.Null(nowhere.Position);
        Assert.Null(nowhere.BsDrawingsPage);
    }

    [Fact]
    public async Task Drawings_that_name_no_position_are_offered_from_the_first_page()
    {
        Put("58931_20261127.pdf", List(1, 3));
        Put("58931_20261127BS tegninger.pdf", Drawings(null, null));

        var load = await Share().LoadAsync(Code("058931010101"));

        Assert.Equal(2, load.BsDrawings!.Pages.Count);
        Assert.Equal(0, load.BsDrawingsPage);
    }

    [Fact]
    public async Task An_element_from_the_BS_list_its_drawings_do_not_name_starts_at_the_first_page()
    {
        Put("58931_20261127.pdf", List(1));
        Put("58931_20261127BS.pdf", List(2, 4));
        Put("58931_20261127BS tegninger.pdf", Drawings(2));

        var load = await Share().LoadAsync(Code("058931040101"));

        Assert.Equal(OrderDocumentKind.BsList, load.Kind);
        Assert.Equal(0, load.BsDrawingsPage);
    }

    [Fact]
    public async Task The_newest_drawings_file_wins_by_the_date_in_its_name_then_by_when_it_was_written()
    {
        Put("58931_20261127.pdf", List(2));
        Put("B S tegninger 58931_20261112.pdf", Drawings(2), new DateTime(2026, 11, 27, 12, 0, 0, DateTimeKind.Utc));
        Put("58931_20261127BS tegninger.pdf", Drawings(9, 2), new DateTime(2026, 11, 27, 8, 0, 0, DateTimeKind.Utc));
        var newest = Put("58931_20261127BS tegninger rev2.pdf", Drawings(9, 9, 2), new DateTime(2026, 11, 27, 9, 0, 0, DateTimeKind.Utc));

        var load = await Share().LoadAsync(Code("058931020101"));

        Assert.Equal(newest, load.BsDrawings!.Path);
        Assert.Equal(2, load.BsDrawingsPage);
    }

    [Fact]
    public async Task An_order_without_drawings_or_with_a_file_that_cannot_be_read_still_has_its_document()
    {
        Put("58931_20261127.pdf", List(1));
        var none = await Share().LoadAsync(Code("058931010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, none.Status);
        Assert.Null(none.BsDrawings);
        Assert.Null(none.BsDrawingsPage);

        Put("58931_20261127BS tegninger.pdf", "not a pdf"u8.ToArray());
        var broken = await Share().LoadAsync(Code("058931010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, broken.Status);
        Assert.Equal(1, broken.Position!.Number);
        Assert.Null(broken.BsDrawings);
    }

    [Fact]
    public async Task An_order_with_only_drawings_shows_them_as_its_document_and_offers_them()
    {
        var path = Put("58931_20261127BS tegninger.pdf", Drawings(2));

        var load = await Share().LoadAsync(Code("058931020101"));

        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.Equal(path, load.Path);
        Assert.Equal(OrderDocumentKind.BsDrawings, load.Kind);
        Assert.Null(load.Position);
        Assert.Equal(0, load.BsDrawingsPage);
    }

    [Fact]
    public async Task The_drawings_are_read_once_for_every_element_of_the_order()
    {
        Put("58931_20261127.pdf", List(1));
        Put("58931_20261127BS.pdf", List(2));
        var drawings = Put("58931_20261127BS tegninger.pdf", Drawings(2));
        var reads = new List<string>();
        var docs = new OrderDocuments(new OrderDocumentLocator(Path.Combine(_root, "share")),
            p => { lock (reads) reads.Add(p); return File.ReadAllBytes(p); });

        var first = await docs.LoadAsync(Code("058931020101"));
        var second = await docs.LoadAsync(Code("058931020102"));

        Assert.Same(first.BsDrawings!.Pdf, second.BsDrawings!.Pdf);
        Assert.Same(first.BsDrawings.Pages, second.BsDrawings.Pages);
        Assert.Equal(first.BsDrawings.FileKey, second.BsDrawings.FileKey);
        Assert.Single(reads, p => p == drawings);
    }

    [Fact]
    public async Task With_the_share_gone_the_drawings_come_from_memory_and_after_a_restart_from_the_copy_on_this_pc()
    {
        Put("58931_20261127.pdf", List(1, 3));
        Put("58931_20261127BS.pdf", List(2));
        var drawings = Put("58931_20261127BS tegninger.pdf", Drawings(2));
        var cache = new OrderDocumentCache(Path.Combine(_root, "cache"));
        var docs = Share(cache);
        Assert.Equal(0, (await docs.LoadAsync(Code("058931020101"))).BsDrawingsPage);

        Directory.Delete(Path.Combine(_root, "share"), recursive: true);
        var fromMemory = await docs.LoadAsync(Code("058931020101"));
        Assert.True(fromMemory.FromCopy);
        Assert.Equal(2, fromMemory.Position!.Number);
        Assert.True(fromMemory.BsDrawings!.FromCopy);
        Assert.Equal(0, fromMemory.BsDrawingsPage);

        // After a restart nothing lists the share, so nothing says the order has BS files: the list's
        // copy answers, and the copy of the drawings is found by its kind.
        Assert.Equal(Path.Combine(_root, "cache", OrderDocumentCache.NameFor(drawings)), cache.Find(58931, null, OrderDocumentKind.BsDrawings));
        Assert.EndsWith("58931_20261127.pdf", cache.Find(58931));
        Assert.EndsWith("58931_20261127BS.pdf", cache.Find(58931, null, OrderDocumentKind.BsList));
        Assert.Null(cache.Find(58932, null, OrderDocumentKind.BsDrawings));
    }

    // ---- From OptiCloud

    static string Ref(string name) => $"masterdata/{FakeOptiCloud.Account}/{name}";

    static FakeOptiCloud Cloud(Dictionary<string, byte[]> files)
    {
        var api = new FakeOptiCloud();
        var t = new FakeOptiCloud.Table(Guid.NewGuid(), OrderDocumentUpload.Name);
        foreach (var c in OrderDocumentUpload.Columns) t.Columns.Add((c.Name, (int)c.Type));
        foreach (var name in files.Keys)
        {
            var row = new JsonObject
            {
                ["FileName"] = name, ["Device"] = "PC-1", ["Sha256"] = "sha-" + name,
                ["File"] = new JsonObject { ["name"] = name, ["contentType"] = "application/pdf", ["reference"] = Ref(name) },
            };
            t.Rows.Add(row);
            t.Ids[row] = Guid.NewGuid();
        }
        api.Tables.Add(t);
        api.Override = (_, path, _) =>
        {
            if (!path.StartsWith("api/MasterDataBlob/Get")) return null;
            var name = Uri.UnescapeDataString(path.Split("path=")[1]).Split('/')[^1];
            return files.TryGetValue(name, out var bytes)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        };
        return api;
    }

    static OrderDocuments FromCloud(OptiCloudClient? client, OrderDocumentCache? cache = null) =>
        new(new OrderDocumentLocator(null), cache: cache)
        {
            Cloud = new CloudDocumentSource(() => client is null ? null : (client, FakeOptiCloud.Account)),
        };

    [Fact(Timeout = 10000)]
    public async Task A_lookup_in_opticloud_gives_the_newest_file_of_each_kind()
    {
        var api = Cloud(new()
        {
            ["58931_20261127.pdf"] = List(1),
            ["58931_20261127BS.pdf"] = List(2),
            ["B S 58931_20261112.pdf"] = List(2),
            ["58931_20261127BS tegninger.pdf"] = Drawings(2),
            ["B S tegninger 58931_20261112.pdf"] = Drawings(2),
            ["58930_20261127BS tegninger.pdf"] = Drawings(1),
        });
        using var client = api.Client();
        var source = new CloudDocumentSource(() => (client, FakeOptiCloud.Account));

        var found = await source.FindAsync(58931);

        Assert.Equal(CloudDocumentStatus.Found, found.Status);
        Assert.Equal("58931_20261127.pdf", found.Document!.FileName);
        Assert.Equal(["58931_20261127.pdf", "58931_20261127BS.pdf", "58931_20261127BS tegninger.pdf"], found.Parts.Select(p => p.FileName));
        Assert.Equal("58931_20261127BS tegninger.pdf", found.Part(OrderDocumentKind.BsDrawings)!.FileName);

        var only = await source.FindAsync(58930);
        Assert.Equal("58930_20261127BS tegninger.pdf", only.Document!.FileName);
        Assert.Null(only.Part(OrderDocumentKind.List));
        Assert.Empty((await source.FindAsync(58929)).Parts);
    }

    [Fact(Timeout = 10000)]
    public async Task From_opticloud_a_position_the_list_lacks_comes_from_the_BS_list_with_its_drawings()
    {
        var api = Cloud(new()
        {
            ["58931_20261127.pdf"] = List(1, 3),
            ["58931_20261127BS.pdf"] = List(2, 4),
            ["58931_20261127BS tegninger.pdf"] = Drawings(2, 4),
        });
        using var client = api.Client();
        var docs = FromCloud(client);

        var bs = await docs.LoadAsync(Code("058931040101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, bs.Status);
        Assert.Equal(Path.Combine("OptiCloud", "58931_20261127BS.pdf"), bs.Path);
        Assert.Equal(OrderDocumentKind.BsList, bs.Kind);
        Assert.Equal(4, bs.Position!.Number);
        Assert.Equal(Path.Combine("OptiCloud", "58931_20261127BS tegninger.pdf"), bs.BsDrawings!.Path);
        Assert.Equal(1, bs.BsDrawingsPage);

        var ordinary = await docs.LoadAsync(Code("058931010101"));
        Assert.Equal(Path.Combine("OptiCloud", "58931_20261127.pdf"), ordinary.Path);
        Assert.Equal(1, ordinary.Position!.Number);
        Assert.Null(ordinary.BsDrawingsPage);

        // In neither list: the list answers, without a position.
        var nowhere = await docs.LoadAsync(Code("058931090101"));
        Assert.Equal(Path.Combine("OptiCloud", "58931_20261127.pdf"), nowhere.Path);
        Assert.Null(nowhere.Position);

        // Each file came down once.
        Assert.Equal(3, api.Count("api/MasterDataBlob/Get"));
    }

    [Fact(Timeout = 10000)]
    public async Task From_opticloud_an_order_with_no_BS_files_asks_for_nothing_more()
    {
        var api = Cloud(new() { ["58931_20261127.pdf"] = List(1) });
        using var client = api.Client();
        var docs = FromCloud(client);

        var load = await docs.LoadAsync(Code("058931020101"));

        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.Null(load.Position);
        Assert.Null(load.BsDrawings);
        Assert.Equal(1, api.Count("api/MasterDataBlob/Get"));
    }

    [Fact(Timeout = 10000)]
    public async Task With_opticloud_out_of_reach_the_BS_list_and_drawings_come_from_the_copies_on_this_pc()
    {
        var cacheDir = Path.Combine(_root, "cache");
        var api = Cloud(new()
        {
            ["58931_20261127.pdf"] = List(1, 3),
            ["58931_20261127BS.pdf"] = List(2),
            ["58931_20261127BS tegninger.pdf"] = Drawings(2),
        });
        using (var client = api.Client())
            Assert.Equal(0, (await FromCloud(client, new OrderDocumentCache(cacheDir)).LoadAsync(Code("058931020101"))).BsDrawingsPage);

        // After a restart, before the connection is up.
        var load = await FromCloud(null, new OrderDocumentCache(cacheDir)).LoadAsync(Code("058931020101"));

        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.True(load.FromCopy);
        Assert.Equal(OrderDocumentKind.BsList, load.Kind);
        Assert.Equal(2, load.Position!.Number);
        Assert.True(load.BsDrawings!.FromCopy);
        Assert.Equal(0, load.BsDrawingsPage);
    }
}
