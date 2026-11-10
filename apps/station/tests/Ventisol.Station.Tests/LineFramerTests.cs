using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class LineFramerTests
{
    [Theory]
    [InlineData("058556050103\r\n")]
    [InlineData("058556050103\r")]
    [InlineData("058556050103\n")]
    public void Ends_a_line_at_CR_LF_or_CRLF(string text)
    {
        Assert.Equal(["058556050103"], new LineFramer().Push(text));
    }

    [Fact]
    public void Joins_a_line_split_over_chunks()
    {
        var f = new LineFramer();
        Assert.Empty(f.Push("0585"));
        Assert.Empty(f.Push("56050"));
        Assert.Equal(["058556050103"], f.Push("103\r\n"));
    }

    [Fact]
    public void A_CRLF_split_over_chunks_gives_one_line()
    {
        var f = new LineFramer();
        Assert.Equal(["058556050103"], f.Push("058556050103\r"));
        Assert.Equal(["058557010101"], f.Push("\n058557010101\r\n"));
    }

    [Fact]
    public void Gives_every_line_in_a_chunk()
    {
        Assert.Equal(["A", "B", "C"], new LineFramer().Push("A\r\nB\nC\r"));
    }

    [Fact]
    public void Drops_blank_lines_and_trims()
    {
        Assert.Equal(["S3 058556050103"], new LineFramer().Push("\r\n  \r\n\t S3 058556050103 \r\n\r\n"));
    }

    [Fact]
    public void Holds_a_line_until_its_end_comes()
    {
        var f = new LineFramer();
        Assert.Empty(f.Push("058556050103"));
        Assert.Equal(["058556050103"], f.Push("\n"));
    }

    [Fact]
    public void Caps_a_line_that_never_ends()
    {
        var f = new LineFramer(maxLength: 5);
        Assert.Empty(f.Push("1234567890"));
        Assert.Equal(["12345"], f.Push("\r\n"));
    }

    // A Zebra cradle in CDC mode sent the barcode with no line end; the reader flushes on a pause.
    [Fact]
    public void Flush_gives_what_came_with_no_line_end()
    {
        var f = new LineFramer();
        Assert.Empty(f.Push("05855605"));
        Assert.Empty(f.Push("0101"));
        Assert.True(f.HasPending);
        Assert.Equal("058556050101", f.Flush());
        Assert.False(f.HasPending);
        Assert.Null(f.Flush());
    }

    [Fact]
    public void Flush_after_a_whole_line_has_nothing()
    {
        var f = new LineFramer();
        Assert.Equal(["058556050101"], f.Push("058556050101\r\n"));
        Assert.False(f.HasPending);
        Assert.Null(f.Flush());
    }
}
