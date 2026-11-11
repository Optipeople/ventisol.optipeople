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
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0585560501")]
    [InlineData("05855605010")] // 12 digits with the last one lost, not a missing leading 0
    [InlineData("05856050103")] // 12 digits with a middle one lost
    [InlineData("0585560501034")]
    [InlineData("05866002010301")]
    [InlineData("05855605010A")]
    public void Rejects_invalid_barcodes(string? text)
    {
        Assert.False(Barcode.TryParse(text, out _));
    }
}
