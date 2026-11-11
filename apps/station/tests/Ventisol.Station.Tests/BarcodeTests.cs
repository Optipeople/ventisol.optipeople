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
