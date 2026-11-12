using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class BarcodeTests
{
    [Theory]
    [InlineData("057000010101")]   // An order older than OldestOrder.
    [InlineData("158830010101")]   // Twelve digits that do not begin with 0.
    [InlineData("099999010101")]   // An order far above the newest one known.
    public void The_element_in_progress_is_read_whatever_its_order(string text)
    {
        var hints = new OrderHints(Exists: _ => false, Recent: 58830);
        Assert.False(Barcode.TryParseScan(text, out _, hints));
        Assert.True(Barcode.TryParse(text, out var inProgress));

        Assert.True(Barcode.TryParseInProgress(text, inProgress, out var b, hints));
        Assert.Equal(inProgress.Raw, b.Raw);
        // Only that very element: another one is not let in this way, nor is anything with none in progress.
        Assert.False(Barcode.TryParseInProgress("057000010102", inProgress, out _, hints));
        Assert.False(Barcode.TryParseInProgress(text, null, out _, hints));
        Assert.False(Barcode.TryParseInProgress("not a barcode", inProgress, out _, hints));
    }

    [Fact]
    public void Parses_the_pallet_label_sample()
    {
        Assert.True(Barcode.TryParse("058556050103", out var b));
        Assert.Equal(58556, b.Order);
        Assert.Equal(5, b.Position);
        Assert.Equal(1, b.SubPosition);
        Assert.Equal(3, b.Piece);
        Assert.Equal("Pos. 5", b.PositionLabel);
    }

    [Fact]
    public void Trims_the_scanner_suffix()
    {
        Assert.True(Barcode.TryParse(" 058556050103\r\n", out var b));
        Assert.Equal("058556050103", b.Raw);
    }

    [Fact]
    public void Accepts_11_digit_barcode_without_leading_zero()
    {
        Assert.True(Barcode.TryParse("58556050103", out var b));
        Assert.Equal("058556050103", b.Raw);
        Assert.Equal(58556, b.Order);
        Assert.Equal(5, b.Position);
        Assert.Equal(1, b.SubPosition);
        Assert.Equal(3, b.Piece);
    }

    [Theory]
    [InlineData("05872102010104")]
    [InlineData("5872102010104")] // 14 digits without the leading 0
    public void Reads_a_14_digit_profile_label_as_its_element(string text)
    {
        Assert.True(Barcode.TryParse(text, out var b));
        Assert.Equal("058721020101", b.Raw);
        Assert.Equal(58721, b.Order);
        Assert.Equal(2, b.Position);
        Assert.Equal(1, b.SubPosition);
        Assert.Equal(1, b.Piece);
        Assert.Equal("Pos. 2", b.PositionLabel);
    }

    [Theory]
    [InlineData("03058830010105", "058830030101")] // the scan that showed as order 30588
    [InlineData("3058830010105", "058830030101")]  // the same without its leading 0
    [InlineData("01058842010112", "058842010101")]
    [InlineData("02058817010109", "058817020101")]
    [InlineData("12058861020116", "058861120201")]
    public void Reads_a_14_digit_label_with_the_position_first(string text, string element)
    {
        Assert.True(Barcode.TryParse(text, out var b));
        Assert.Equal(element, b.Raw);
    }

    // Every 14-digit label scanned in production on 2026-11-11, read with no hints at all.
    [Theory]
    [InlineData("05872102010104", "058721020101")]
    [InlineData("05883003010114", "058830030101")]
    [InlineData("05855805020122", "058558050201")]
    [InlineData("05855805020123", "058558050201")]
    [InlineData("01058842010112", "058842010101")]
    [InlineData("01058846010109", "058846010101")]
    [InlineData("01058832010109", "058832010101")]
    [InlineData("02058817010109", "058817020101")]
    [InlineData("01058865010109", "058865010101")]
    [InlineData("01058843010109", "058843010101")]
    [InlineData("02058833010109", "058833020101")]
    [InlineData("01058837010109", "058837010101")]
    [InlineData("01058861020116", "058861010201")]
    [InlineData("03058830010105", "058830030101")]
    [InlineData("02058764010115", "058764020101")]
    [InlineData("01058758010109", "058758010101")]
    [InlineData("01058740010114", "058740010101")]
    [InlineData("01058740010115", "058740010101")]
    public void Reads_every_label_scanned_in_production(string text, string element)
    {
        Assert.True(Barcode.TryParse(text, out var b));
        Assert.Equal(element, b.Raw);
    }

    // Labels that fit both layouts once orders reach 60000, 70000 ...: the right reading must win.
    [Theory]
    [InlineData("06012345010114", "060123450101")] // order 60123 Pos. 45, order first: 12345 is too old
    [InlineData("06065003010114", "060650030101")] // order 60650 Pos. 3, order first: 60650 is below 65003
    [InlineData("06060123010105", "060123060101")] // order 60123 Pos. 6, position first: 60123 is below 60601
    [InlineData("07070123010105", "070123070101")] // order 70123 Pos. 7, position first
    public void Reads_future_labels_that_fit_both_layouts(string text, string element)
    {
        Assert.True(Barcode.TryParse(text, out var b));
        Assert.Equal(element, b.Raw);
    }

    [Fact]
    public void The_order_nearer_the_work_going_on_wins()
    {
        // Order 70650 Pos. 3, order first; position first would read order 65003.
        Assert.True(Barcode.TryParse("07065003010114", out var b, new OrderHints(Recent: 70610)));
        Assert.Equal("070650030101", b.Raw);
        Assert.True(Barcode.TryParse("07065003010114", out var c, new OrderHints(Recent: 65010)));
        Assert.Equal("065003070101", c.Raw);
        // Order 99999 Pos. 9, position first; order first would read 90999, which is lower.
        Assert.True(Barcode.TryParse("09099999010105", out var d, new OrderHints(Recent: 99950)));
        Assert.Equal("099999090101", d.Raw);
    }

    [Fact]
    public void An_order_that_exists_beats_one_nearer_the_work()
    {
        // Order 60598 Pos. 6, position first; order first would read 60605, nearer to 60603.
        var hints = new OrderHints(Exists: o => o == 60598, Recent: 60603);
        Assert.True(Barcode.TryParse("06060598010105", out var b, hints));
        Assert.Equal(60598, b.Order);
        Assert.Equal(6, b.Position);
    }

    [Theory]
    [InlineData("00058830010105")] // position 00, and order first would start 00
    [InlineData("10158830030101")] // neither layout: no 0 first, no 0 third
    public void Rejects_14_digits_that_fit_no_layout(string text)
    {
        Assert.False(Barcode.TryParse(text, out _));
    }

    [Fact]
    public void Both_profile_layouts_of_one_element_read_the_same()
    {
        Assert.True(Barcode.TryParse("05883003010114", out var a));
        Assert.True(Barcode.TryParse("03058830010105", out var b));
        Assert.Equal(a.Raw, b.Raw);
        Assert.Equal(58830, b.Order);
        Assert.Equal(3, b.Position);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0585560501")]
    [InlineData("05855605010")] // 12 digits with the last one lost, not a missing leading 0
    [InlineData("05856050103")] // 12 digits with a middle one lost
    [InlineData("0585560501034")]
    [InlineData("0587210201010")] // 14 digits with one lost
    [InlineData("058721020101041")]
    [InlineData("05855605010A")]
    public void Rejects_invalid_barcodes(string? text)
    {
        Assert.False(Barcode.TryParse(text, out _));
    }

    // What else gets scanned on a factory floor: the retail code on a box of screws or a bottle.
    [Theory]
    [InlineData("5701234567890")]  // EAN-13: with a 0 put first it would read as order 57012
    [InlineData("4006381333931")]  // EAN-13: order 40063
    [InlineData("036000291452")]   // UPC-A: order 36000
    [InlineData("123456789012")]   // 12 digits with no leading 0: an order has five digits
    [InlineData("158556050103")]
    public void An_incoming_retail_code_is_refused(string text)
    {
        Assert.False(Barcode.TryParseScan(text, out _));
        Assert.False(Barcode.TryParseScan(text, out _, new OrderHints(Exists: _ => false, Recent: 58830)));
    }

    [Theory]
    [InlineData("057999050103")]   // 12 digits
    [InlineData("57999050103")]    // 11 digits, the leading 0 lost
    [InlineData("05799903010114")] // 14 digits, order first, the only layout that fits
    [InlineData("12057999020116")] // 14 digits, position first, the only layout that fits
    [InlineData("03057999010105")] // 14 digits that fit both ways, both too old
    public void An_incoming_scan_older_than_the_oldest_order_is_refused_unless_the_order_is_known(string text)
    {
        Assert.False(Barcode.TryParseScan(text, out _));
        Assert.False(Barcode.TryParseScan(text, out _, new OrderHints(Exists: _ => false, Recent: 57999)));

        // A remake: the documents folder has the old order's PDF.
        Assert.True(Barcode.TryParseScan(text, out var b, new OrderHints(Exists: o => o == 57999)));
        Assert.Equal(57999, b.Order);
    }

    // Retail codes that read as an order above the oldest one: only an upper limit keeps them out.
    [Theory]
    [InlineData("7310865004703", 73108)] // EAN-13: with a 0 put first, order 73108
    [InlineData("060383123456", 60383)]  // UPC-A: begins with 0, order 60383
    public void An_incoming_retail_code_far_above_the_newest_order_is_refused(string text, int order)
    {
        // The documents folder knows the orders in production, and this is not one of them.
        var folder = new OrderHints(Exists: o => o is 58763 or 58800 or 58802, Newest: 58802);
        Assert.False(Barcode.TryParseScan(text, out _, folder));
        Assert.False(Barcode.TryParseScan(text, out _, new OrderHints(folder.Exists, Recent: 58800, Newest: 58802)));
        // No documents folder, but an element was scanned before.
        Assert.False(Barcode.TryParseScan(text, out _, new OrderHints(Recent: 58800)));
        Assert.False(Barcode.TryParseScan(text, out _, new OrderHints(Exists: _ => false, Recent: 58800)));

        // Stored already: read as it always was.
        Assert.True(Barcode.TryParse(text, out var stored, folder));
        Assert.Equal(order, stored.Order);
    }

    [Theory]
    [InlineData("058802010101", 58802)] // the newest known order itself
    [InlineData("058850010101", 58850)] // a little above it: its PDF is not in the folder yet
    [InlineData("58850010101", 58850)]  // the same, the leading 0 lost
    [InlineData("05885001010114", 58850)] // a profile label, order first
    public void An_incoming_label_a_little_above_the_newest_order_is_read(string text, int order)
    {
        var folder = new OrderHints(Exists: o => o is 58763 or 58800 or 58802, Newest: 58802);
        Assert.True(Barcode.TryParseScan(text, out var b, folder));
        Assert.Equal(order, b.Order);
        Assert.True(Barcode.TryParseScan(text, out b, new OrderHints(Recent: 58802)));
        Assert.Equal(order, b.Order);
    }

    [Fact]
    public void The_upper_limit_is_the_margin_above_the_newest_order_known()
    {
        var at = $"0{58802 + Barcode.NewestOrderMargin}010101";
        var over = $"0{58802 + Barcode.NewestOrderMargin + 1}010101";
        foreach (var hints in new[] { new OrderHints(Newest: 58802), new OrderHints(Recent: 58802), new OrderHints(Recent: 58700, Newest: 58802), new OrderHints(Recent: 58802, Newest: 58700) })
        {
            Assert.True(Barcode.TryParseScan(at, out _, hints));
            Assert.False(Barcode.TryParseScan(over, out _, hints));
        }
    }

    [Fact]
    public void An_order_the_documents_folder_knows_is_read_however_far_above()
    {
        var hints = new OrderHints(Exists: o => o == 73108, Recent: 58800, Newest: 58802);
        Assert.True(Barcode.TryParseScan("073108650047", out var b, hints));
        Assert.Equal(73108, b.Order);
    }

    // No time bomb: a station that knows no order at all (no documents folder, or not listed yet,
    // and nothing scanned) has no upper limit, and one that only knows old orders still reads today's.
    [Fact]
    public void Without_a_known_order_there_is_no_upper_limit()
    {
        foreach (var hints in new OrderHints?[] { null, new OrderHints(), new OrderHints(Exists: _ => false) })
        {
            Assert.True(Barcode.TryParseScan("099999010101", out var b, hints));
            Assert.Equal(99999, b.Order);
            Assert.True(Barcode.TryParseScan("7310865004703", out b, hints));
            Assert.Equal(73108, b.Order);
        }
    }

    [Fact]
    public void A_known_order_older_than_the_oldest_does_not_lower_the_limit()
    {
        // The last scan was a remake of an old order, and the folder only holds old PDFs.
        var hints = new OrderHints(Exists: o => o == 41000, Recent: 41000, Newest: 41000);
        Assert.True(Barcode.TryParseScan("058830030101", out var b, hints));
        Assert.Equal(58830, b.Order);
        Assert.True(Barcode.TryParseScan($"0{Barcode.OldestOrder + Barcode.NewestOrderMargin}010101", out _, hints));
        Assert.False(Barcode.TryParseScan($"0{Barcode.OldestOrder + Barcode.NewestOrderMargin + 1}010101", out _, hints));
    }

    [Fact]
    public void The_limit_follows_the_orders_as_they_grow()
    {
        // Years on: each accepted scan is the next one's Recent, so the limit moves with production.
        int? recent = 58802;
        for (var order = 58900; order <= 99000; order += Barcode.NewestOrderMargin - 100)
        {
            Assert.True(Barcode.TryParseScan($"0{order}010101", out var b, new OrderHints(Recent: recent, Newest: 58802)));
            recent = b.Order;
        }
    }

    [Fact]
    public void The_oldest_order_itself_is_read()
    {
        Assert.True(Barcode.TryParseScan($"0{Barcode.OldestOrder}010101", out var b));
        Assert.Equal(Barcode.OldestOrder, b.Order);
    }

    // What is already stored (outbox files, journal lines, rows in OptiCloud) is read as it always was.
    [Theory]
    [InlineData("057999050103", 57999)]
    [InlineData("57999050103", 57999)]
    [InlineData("05799903010114", 57999)]
    [InlineData("12057999020116", 57999)]
    [InlineData("042117030201", 42117)]
    [InlineData("158556050103", 58556)] // 12 digits with another first digit were read too
    public void A_stored_barcode_is_read_whatever_its_order(string text, int order)
    {
        Assert.True(Barcode.TryParse(text, out var b));
        Assert.Equal(order, b.Order);
    }

    [Fact]
    public void An_incoming_scan_reads_like_a_stored_one_when_it_is_an_element()
    {
        foreach (var text in new[] { "058556050103", "58556050103", "05883003010114", "03058830010105" })
        {
            Assert.True(Barcode.TryParse(text, out var stored));
            Assert.True(Barcode.TryParseScan(text, out var scanned));
            Assert.Equal(stored, scanned);
        }
    }
}
