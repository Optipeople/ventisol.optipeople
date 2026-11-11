using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class BarcodeTests
{
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
}
