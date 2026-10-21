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

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("05855605010")]
    [InlineData("05866002010301")]
    [InlineData("05855605010A")]
    public void Rejects_anything_but_12_digits(string? text)
    {
        Assert.False(Barcode.TryParse(text, out _));
    }
}
