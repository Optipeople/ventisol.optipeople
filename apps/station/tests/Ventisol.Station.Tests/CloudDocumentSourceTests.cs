using System.Net;
using System.Text.Json.Nodes;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using Ventisol.Station.Core.Documents;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Writer;

namespace Ventisol.Station.Tests;

public sealed class CloudDocumentSourceTests : IDisposable
{
    static readonly DateTimeOffset Start = new(2026, 11, 18, 9, 0, 0, TimeSpan.Zero);
    const string BlobGet = "api/MasterDataBlob/Get";

    readonly string _root = TestScans.TempFolder();
    DateTimeOffset _now = Start;

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    static byte[] BlankPdf()
    {
        var builder = new PdfDocumentBuilder();
        builder.AddPage(PageSize.A4);
        return builder.Build();
    }

    static string Ref(string name) => $"masterdata/{FakeOptiCloud.Account}/{name}";

    // The list as the scan PCs leave it. A null reference is a row still waiting for its file.
    static FakeOptiCloud.Table List(FakeOptiCloud api, params (string Name, string? Reference, DateTimeOffset? Created)[] rows)
    {
        var t = new FakeOptiCloud.Table(Guid.NewGuid(), OrderDocumentUpload.Name);
        foreach (var c in OrderDocumentUpload.Columns) t.Columns.Add((c.Name, (int)c.Type));
        foreach (var (name, reference, created) in rows)
        {
            var row = new JsonObject { ["FileName"] = name, ["Device"] = "PC-1", ["Sha256"] = "sha-" + name };
            if (reference is not null) row["File"] = new JsonObject { ["name"] = name, ["contentType"] = "application/pdf", ["reference"] = reference };
            t.Rows.Add(row);
            t.Ids[row] = Guid.NewGuid();
            if (created is { } when) api.CreatedAt[row] = when;
        }
        api.Tables.Add(t);
        return t;
    }

    static FakeOptiCloud.Table List(FakeOptiCloud api, params string[] names) =>
        List(api, [.. names.Select(n => (n, (string?)Ref(n), (DateTimeOffset?)null))]);

    CloudDocumentSource Source(OptiCloudClient? client) =>
        new(() => client is null ? null : (client, FakeOptiCloud.Account)) { Clock = () => _now };

    // Answers the file downloads from the given files by reference; anything else goes to the fake.
    static void Serve(FakeOptiCloud api, Dictionary<string, byte[]> files) =>
        api.Override = (method, path, _) =>
        {
            if (!path.StartsWith(BlobGet)) return null;
            var reference = Uri.UnescapeDataString(path.Split("path=")[1]);
            return files.TryGetValue(reference, out var bytes)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        };

    // ---- FindAsync ----

    [Fact(Timeout = 10000)]
    public async Task The_keyword_search_finds_the_newest_date_in_the_name_with_a_prefix_and_skips_rows_without_a_file_and_other_orders()
    {
        var api = new FakeOptiCloud();
        List(api,
            ("58721_20261022.pdf", Ref("a"), null),
            ("BE_58721_20261105.pdf", Ref("be"), null),
            // Newer, but no file yet.
            ("58721_20261201.pdf", null, null),
            // Contains the order's digits, but is another order.
            ("158721_20261231.pdf", Ref("other"), null),
            ("58800_20261230.pdf", Ref("58800"), null));
        using var client = api.Client();

        var found = await Source(client).FindAsync(58721);

        Assert.Equal(CloudDocumentStatus.Found, found.Status);
        Assert.Equal("BE_58721_20261105.pdf", found.Document!.FileName);
        Assert.Equal(58721, found.Document.Order);
        Assert.Equal(new DateOnly(2026, 11, 5), found.Document.Date);
        Assert.Equal(Ref("be"), found.Document.Reference);
        Assert.Equal("sha-BE_58721_20261105.pdf", found.Document.Sha256);
        // A keyword hit needs no full read of the list, and the list is never made here.
        var paged = api.Snapshot().Where(r => r.Path.Contains("GetRowsPaged")).ToList();
        Assert.Single(paged);
        Assert.Contains("keyword=58721", paged[0].Path);
        Assert.Equal(0, api.Count("CreateTable"));
    }

    [Fact(Timeout = 10000)]
    public async Task On_the_same_date_the_newest_row_wins()
    {
        var api = new FakeOptiCloud();
        List(api,
            ("58721_20261022.pdf", Ref("new"), Start),
            ("TE_58721_20261022.pdf", Ref("old"), Start.AddDays(-1)));
        using var client = api.Client();

        var found = await Source(client).FindAsync(58721);
        Assert.Equal(Ref("new"), found.Document!.Reference);
    }

    [Fact(Timeout = 10000)]
    public async Task A_keyword_miss_falls_back_to_the_whole_list()
    {
        var api = new FakeOptiCloud { Keyword = FakeOptiCloud.Search.FindsNothing, MaxPageSize = 2 };
        List(api, "58800_20261022.pdf", "58721_20261022.pdf", "58721_20261030.pdf", "58900_20261022.pdf", "BE_58721_20261029.pdf");
        using var client = api.Client();

        var found = await Source(client).FindAsync(58721);

        Assert.Equal(CloudDocumentStatus.Found, found.Status);
        Assert.Equal("58721_20261030.pdf", found.Document!.FileName);
        // One keyword search, then the list page by page without a keyword.
        var paged = api.Snapshot().Where(r => r.Path.Contains("GetRowsPaged")).ToList();
        Assert.Contains("keyword=", paged[0].Path);
        Assert.True(paged.Count >= 2);
        Assert.All(paged.Skip(1), r => Assert.DoesNotContain("keyword=", r.Path));
    }

    [Fact(Timeout = 10000)]
    public async Task An_order_neither_search_finds_is_not_found()
    {
        var api = new FakeOptiCloud { Keyword = FakeOptiCloud.Search.FindsNothing };
        List(api, "58800_20261022.pdf");
        using var client = api.Client();
        Assert.Equal(CloudDocumentStatus.NotFound, (await Source(client).FindAsync(58721)).Status);
    }

    [Fact(Timeout = 10000)]
    public async Task No_list_in_opticloud_is_not_found_and_the_list_is_not_made()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();

        var lookup = await Source(client).FindAsync(58721);

        Assert.Equal(CloudDocumentStatus.NotFound, lookup.Status);
        Assert.Equal(0, api.Count("CreateTable"));
        Assert.Equal(0, api.Count("GetRowsPaged"));
    }

    [Fact(Timeout = 10000)]
    public async Task Without_a_connection_it_is_unavailable()
    {
        var lookup = await Source(null).FindAsync(58721);
        Assert.Equal(CloudDocumentStatus.Unavailable, lookup.Status);
        Assert.Equal("Ikke forbundet til OptiCloud endnu", lookup.Error);
    }

    [Fact(Timeout = 10000)]
    public async Task An_opticloud_error_or_no_answer_is_unavailable()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        api.Override = (_, path, _) => path.Contains("GetTables") ? new HttpResponseMessage(HttpStatusCode.InternalServerError) : null;
        using var client = api.Client();
        var source = Source(client);

        var error = await source.FindAsync(58721);
        Assert.Equal(CloudDocumentStatus.Unavailable, error.Status);
        Assert.Contains("500", error.Error);

        var down = new FakeOptiCloud { Down = true };
        using var downClient = down.Client();
        var gone = await Source(downClient).FindAsync(58721);
        Assert.Equal(CloudDocumentStatus.Unavailable, gone.Status);
        Assert.StartsWith(OptiCloudException.Unreachable, gone.Error);

        // Unavailable is not kept: once OptiCloud answers, the order is found.
        api.Override = null;
        Assert.Equal(CloudDocumentStatus.Found, (await source.FindAsync(58721)).Status);
    }

    [Fact(Timeout = 10000)]
    public async Task A_found_document_is_kept_for_30_seconds()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        using var client = api.Client();
        var source = Source(client);

        var first = await source.FindAsync(58721);
        var asked = api.Snapshot().Count;

        _now = Start + CloudDocumentSource.RefreshAfter - TimeSpan.FromSeconds(1);
        var second = await source.FindAsync(58721);
        Assert.Equal(CloudDocumentStatus.Found, second.Status);
        Assert.Same(first.Document, second.Document);
        Assert.Equal(asked, api.Snapshot().Count);

        // A newer file in the list is seen once that has run out; the list's id is kept.
        var t = api.Tables.Single();
        var row = new JsonObject { ["FileName"] = "58721_20261030.pdf", ["File"] = new JsonObject { ["reference"] = Ref("newer") } };
        t.Rows.Add(row);
        t.Ids[row] = Guid.NewGuid();
        _now = Start + CloudDocumentSource.RefreshAfter;
        var third = await source.FindAsync(58721);
        Assert.Equal("58721_20261030.pdf", third.Document!.FileName);
        Assert.Equal(1, api.Count("GetTables"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_miss_is_kept_for_5_seconds_then_asked_again()
    {
        var api = new FakeOptiCloud();
        List(api, "58800_20261022.pdf");
        using var client = api.Client();
        var source = Source(client);

        Assert.Equal(CloudDocumentStatus.NotFound, (await source.FindAsync(58721)).Status);
        var searches = api.Count("keyword=");
        Assert.Equal(1, searches);

        _now = Start + CloudDocumentSource.MissRefreshAfter - TimeSpan.FromMilliseconds(1);
        Assert.Equal(CloudDocumentStatus.NotFound, (await source.FindAsync(58721)).Status);
        Assert.Equal(1, api.Count("keyword="));

        // The scan PC has put it in since.
        var t = api.Tables.Single();
        var row = new JsonObject { ["FileName"] = "58721_20261022.pdf", ["File"] = new JsonObject { ["reference"] = Ref("late") } };
        t.Rows.Add(row);
        t.Ids[row] = Guid.NewGuid();
        _now = Start + CloudDocumentSource.MissRefreshAfter;
        var found = await source.FindAsync(58721);
        Assert.Equal(CloudDocumentStatus.Found, found.Status);
        Assert.Equal(2, api.Count("keyword="));
    }

    [Fact(Timeout = 10000)]
    public async Task A_forgotten_order_is_asked_again_at_once()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        using var client = api.Client();
        var source = Source(client);

        await source.FindAsync(58721);
        source.Forget(58721);
        await source.FindAsync(58721);
        Assert.Equal(2, api.Count("keyword="));
    }

    [Fact]
    public void A_row_gives_a_document_only_with_an_order_name_and_a_file()
    {
        static CloudRow Row(string? name, string? file) =>
            new(Guid.NewGuid(), Start, new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase) { ["fileName"] = name, ["file"] = file });

        Assert.Equal("ref/1", CloudDocumentSource.ToDocument(Row(" 58721_20261022.pdf ", """{"name":"x","contentType":"application/pdf","reference":"ref/1"}"""))!.Reference);
        Assert.Equal("ref/2", CloudDocumentSource.ToDocument(Row("58721_20261022.pdf", "ref/2"))!.Reference);
        Assert.Equal("58721_20261022.pdf", CloudDocumentSource.ToDocument(Row(" 58721_20261022.pdf ", "r"))!.FileName);
        Assert.Null(CloudDocumentSource.ToDocument(Row("58721_20261022.pdf", """{"name":null,"contentType":null,"reference":null}""")));
        Assert.Null(CloudDocumentSource.ToDocument(Row("58721_20261022.pdf", null)));
        Assert.Null(CloudDocumentSource.ToDocument(Row("58721_20261022.pdf", "{ not json")));
        Assert.Null(CloudDocumentSource.ToDocument(Row("notes.pdf", "ref/3")));
        Assert.Null(CloudDocumentSource.ToDocument(Row(null, "ref/3")));
    }

    // ---- DownloadFileAsync ----

    [Fact(Timeout = 10000)]
    public async Task A_file_downloads_as_its_bytes_with_the_bearer_token()
    {
        var api = new FakeOptiCloud();
        byte[] pdf = [1, 2, 3, 4, 5];
        var reference = Ref("dir/58721 20261022.pdf");
        Serve(api, new() { [reference] = pdf });
        using var client = api.Client();

        Assert.Equal(pdf, await client.DownloadFileAsync(reference, 100));

        var get = Assert.Single(api.Snapshot(), r => r.Path.StartsWith(BlobGet));
        Assert.Equal("GET", get.Method);
        Assert.Equal($"{BlobGet}?path={Uri.EscapeDataString(reference)}", get.Path);
        Assert.Equal("Bearer token-1", get.Auth);
    }

    [Fact(Timeout = 10000)]
    public async Task A_stale_token_is_renewed_once_for_a_download()
    {
        var api = new FakeOptiCloud();
        api.Override = (_, path, _) =>
        {
            if (!path.StartsWith(BlobGet)) return null;
            var auth = api.Snapshot().Last().Auth;
            return auth == "Bearer token-1"
                ? new HttpResponseMessage(HttpStatusCode.Unauthorized)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([7]) };
        };
        using var client = api.Client();

        Assert.Equal([7], await client.DownloadFileAsync("r", 100));
        Assert.Equal(["Bearer token-1", "Bearer token-2"], api.Snapshot().Where(r => r.Path.StartsWith(BlobGet)).Select(r => r.Auth));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_bigger_than_allowed_is_too_large_by_its_length_or_as_it_streams()
    {
        var api = new FakeOptiCloud();
        var streamed = false;
        api.Override = (_, path, _) =>
        {
            if (!path.StartsWith(BlobGet)) return null;
            if (!streamed) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[11]) };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new NoLength(new byte[200_000])) };
        };
        using var client = api.Client();

        var byLength = await Assert.ThrowsAsync<OrderDocumentTooLargeException>(() => client.DownloadFileAsync("r", 10));
        Assert.Equal(11, byLength.Size);
        // Exactly the limit is fine.
        Assert.Equal(11, (await client.DownloadFileAsync("r", 11)).Length);

        streamed = true;
        var probe = new StreamContent(new NoLength([1]));
        Assert.Null(probe.Headers.ContentLength);
        var byStream = await Assert.ThrowsAsync<OrderDocumentTooLargeException>(() => client.DownloadFileAsync("r", 100_000));
        Assert.True(byStream.Size > 100_000);
        Assert.Equal(200_000, (await client.DownloadFileAsync("r", 200_000)).Length);
    }

    [Fact(Timeout = 10000)]
    public async Task A_missing_file_or_no_answer_is_an_opticloud_error()
    {
        var api = new FakeOptiCloud();
        Serve(api, []);
        using var client = api.Client();
        var missing = await Assert.ThrowsAsync<OptiCloudException>(() => client.DownloadFileAsync("nope", 100));
        Assert.Equal("Filen findes ikke i OptiCloud", missing.Message);
        Assert.Equal(404, missing.Status);

        api.Down = true;
        var down = await Assert.ThrowsAsync<OptiCloudException>(() => client.DownloadFileAsync("nope", 100));
        Assert.StartsWith(OptiCloudException.Unreachable, down.Message);
    }

    // A body whose length is not known up front, as a chunked answer.
    sealed class NoLength(byte[] bytes) : Stream
    {
        readonly MemoryStream _inner = new(bytes);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, Math.Min(count, 4096));
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    // ---- OrderDocuments from OptiCloud ----

    OrderDocuments Documents(CloudDocumentSource source, OrderDocumentCache? cache = null) =>
        new(new OrderDocumentLocator(null), cache: cache) { Cloud = source };

    [Fact]
    public void With_no_folder_and_opticloud_the_documents_are_on_from_opticloud()
    {
        var docs = Documents(Source(null));
        Assert.True(docs.IsOn);
        Assert.Null(docs.Folder);
        Assert.Equal("OptiCloud", docs.SourceName);
        docs.Warm();

        var off = new OrderDocuments(new OrderDocumentLocator(null));
        Assert.False(off.IsOn);
        Assert.Null(off.SourceName);
    }

    [Fact(Timeout = 10000)]
    public async Task A_pdf_in_opticloud_loads_ready_is_read_once_and_kept_on_this_pc()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        Serve(api, new() { [Ref("58721_20261022.pdf")] = BlankPdf() });
        using var client = api.Client();
        var cacheDir = Path.Combine(_root, "cache");
        var docs = Documents(Source(client), new OrderDocumentCache(cacheDir));

        var first = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, first.Status);
        Assert.False(first.FromCopy);
        Assert.Equal(1, first.Document!.PageCount);
        Assert.NotNull(first.Pdf);
        Assert.Equal(Path.Combine("OptiCloud", "58721_20261022.pdf"), first.Path);
        Assert.StartsWith("opticloud|58721_20261022.pdf|", first.FileKey);

        var second = await docs.LoadAsync(Code("058721010102"));
        Assert.Same(first.Document, second.Document);
        Assert.Equal(1, api.Count(BlobGet));
        Assert.True(File.Exists(Path.Combine(cacheDir, OrderDocumentCache.NameFor(Path.Combine("OptiCloud", "58721_20261022.pdf")))));
    }

    [SamplesFact]
    public async Task A_sample_pdf_from_opticloud_loads_with_its_position()
    {
        var sample = OrderDocumentLocator.ListFolder(OrderDocSamples.Folder!, CancellationToken.None).First(e => e.Order == 58721);
        var name = Path.GetFileName(sample.Path);
        var api = new FakeOptiCloud();
        List(api, name);
        Serve(api, new() { [Ref(name)] = File.ReadAllBytes(sample.Path) });
        using var client = api.Client();

        var load = await Documents(Source(client)).LoadAsync(Code("058721010101"));

        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.Equal(1, load.Position!.Number);
        Assert.Equal(58721, load.Document!.Header.OrderNumber);
    }

    [Fact(Timeout = 10000)]
    public async Task An_order_not_in_opticloud_is_not_found()
    {
        var api = new FakeOptiCloud();
        List(api, "58800_20261022.pdf");
        using var client = api.Client();
        Assert.Equal(OrderDocumentLoadStatus.NotFound, (await Documents(Source(client)).LoadAsync(Code("058721010101"))).Status);
    }

    [Fact(Timeout = 10000)]
    public async Task Opticloud_out_of_reach_with_no_copy_is_unavailable()
    {
        var load = await Documents(Source(null), new OrderDocumentCache(Path.Combine(_root, "cache"))).LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.FolderUnavailable, load.Status);
        Assert.Equal("Ikke forbundet til OptiCloud endnu", load.Error);
    }

    [Fact(Timeout = 10000)]
    public async Task Opticloud_out_of_reach_answers_from_the_copy_on_this_pc()
    {
        var cacheDir = Path.Combine(_root, "cache");
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        Serve(api, new() { [Ref("58721_20261022.pdf")] = BlankPdf() });
        using (var client = api.Client())
            Assert.Equal(OrderDocumentLoadStatus.Ready, (await Documents(Source(client), new OrderDocumentCache(cacheDir)).LoadAsync(Code("058721010101"))).Status);

        // After a restart, before the connection is up.
        var load = await Documents(Source(null), new OrderDocumentCache(cacheDir)).LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, load.Status);
        Assert.True(load.FromCopy);
        Assert.Equal(1, load.Document!.PageCount);

        // And with OptiCloud down instead.
        var down = new FakeOptiCloud { Down = true };
        using var downClient = down.Client();
        var copy = await Documents(Source(downClient), new OrderDocumentCache(cacheDir)).LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, copy.Status);
        Assert.True(copy.FromCopy);
    }

    [Fact(Timeout = 10000)]
    public async Task A_listed_file_that_cannot_be_downloaded_is_unreadable_and_looked_up_again()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        Serve(api, []);
        using var client = api.Client();
        var docs = Documents(Source(client));

        var load = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Unreadable, load.Status);
        Assert.Contains("findes ikke i OptiCloud", load.Error);

        Serve(api, new() { [Ref("58721_20261022.pdf")] = BlankPdf() });
        var again = await docs.LoadAsync(Code("058721010101"));
        Assert.Equal(OrderDocumentLoadStatus.Ready, again.Status);
        Assert.Equal(2, api.Count("keyword="));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_in_opticloud_that_is_not_a_pdf_is_unreadable()
    {
        var api = new FakeOptiCloud();
        List(api, "58721_20261022.pdf");
        Serve(api, new() { [Ref("58721_20261022.pdf")] = "not a pdf"u8.ToArray() });
        using var client = api.Client();
        Assert.Equal(OrderDocumentLoadStatus.Unreadable, (await Documents(Source(client)).LoadAsync(Code("058721010101"))).Status);
    }
}
