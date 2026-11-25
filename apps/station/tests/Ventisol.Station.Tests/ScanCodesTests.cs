using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class ScanCodesTests
{
    [Theory]
    [InlineData("VS-START", ScanCommand.Start)]
    [InlineData("VS-PAUSE", ScanCommand.Pause)]
    [InlineData("VS-HOLD", ScanCommand.Hold)]
    [InlineData("VS-UNDO", ScanCommand.Undo)]
    [InlineData("VS-PRINT", ScanCommand.Print)]
    [InlineData("VS-REPRINT", ScanCommand.Reprint)]
    [InlineData("VS-CLEAR", ScanCommand.Clear)]
    public void Every_command_card_is_its_command(string text, ScanCommand expected)
    {
        var code = Assert.IsType<CommandCode>(ScanCodes.Classify(text, null, []));
        Assert.Equal(expected, code.Command);
        Assert.Equal(text, code.Raw);
    }

    [Fact]
    public void Every_command_has_a_word_in_the_registry()
    {
        Assert.Equal(Enum.GetValues<ScanCommand>().Order(), ScanCodes.Commands.Values.Order());
        Assert.All(ScanCodes.Commands.Keys, word => Assert.Matches("^[A-Z]{1,12}$", word));
    }

    [Theory]
    [InlineData("VS+START")]        // A Danish keyboard layout types the US - key as +.
    [InlineData("vs-start")]
    [InlineData("Vs+Start")]
    [InlineData("  VS-START  ")]
    [InlineData("VS-START\r\n")]    // The scanner's suffix.
    [InlineData("\tvs+start ")]
    public void Case_separator_and_spaces_do_not_matter(string text)
    {
        var code = Assert.IsType<CommandCode>(ScanCodes.Classify(text, null, []));
        Assert.Equal(ScanCommand.Start, code.Command);
        Assert.Equal(text.Trim(), code.Raw);
    }

    [Theory]
    [InlineData("VS-PL-2611251007")]
    [InlineData("vs+pl+2611251007")]
    [InlineData("VS+PL-2611251007")]
    [InlineData(" VS-PL-2611251007\r\n")]
    public void A_pallet_label_is_a_pallet(string text)
    {
        var code = Assert.IsType<PalletCode>(ScanCodes.Classify(text, null, []));
        Assert.Equal("2611251007", code.Number);
        Assert.Equal(text.Trim(), code.Raw);
    }

    [Theory]
    [InlineData("VS-PL-0042")]          // Too short.
    [InlineData("VS-PL-26112510071")]   // Too long.
    [InlineData("VS-PL-261125100A")]
    [InlineData("VS-PL-")]
    [InlineData("VS-PL")]
    [InlineData("VS-PL-261125-1-007")]
    public void Any_other_pallet_label_is_unknown(string text)
    {
        var code = Assert.IsType<UnknownCode>(ScanCodes.Classify(text, null, []));
        Assert.True(code.LooksLikeCommand);
    }

    [Theory]
    [InlineData("VS-XYZ")]
    [InlineData("VS-SHIPPED")]          // Proposed, not defined yet.
    [InlineData("VS-HOLD-GLAS")]        // Reserved: a Hold with a reason, not decided.
    [InlineData("VS-")]
    [InlineData("VS-START-")]
    [InlineData("VS-ST ART")]
    [InlineData("VS-058556050103")]
    public void An_unknown_card_is_unknown_and_looks_like_a_command(string text)
    {
        var code = Assert.IsType<UnknownCode>(ScanCodes.Classify(text, null, []));
        Assert.True(code.LooksLikeCommand);
        Assert.Equal(text, code.Raw);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("START")]
    [InlineData("VSSTART")]
    [InlineData("XVS-START")]
    [InlineData("VS START")]
    [InlineData("058556")]
    [InlineData("not a barcode")]
    public void Anything_else_is_an_unknown_barcode(string? text)
    {
        var code = Assert.IsType<UnknownCode>(ScanCodes.Classify(text, null, []));
        Assert.False(code.LooksLikeCommand);
        Assert.Equal(text?.Trim() ?? "", code.Raw);
    }

    [Theory]
    [InlineData("058556050103")]
    [InlineData(" 058556050103\r\n")]
    [InlineData("58556050103")]         // Without the leading 0.
    [InlineData("05883003010114")]      // A profile label, order first.
    [InlineData("03058830010105")]      // A profile label, position first.
    public void Digits_read_as_today(string text)
    {
        var hints = new OrderHints(Recent: 58830);
        Assert.True(Barcode.TryParseScan(text, out var expected, hints));

        var code = Assert.IsType<ElementCode>(ScanCodes.Classify(text, hints, []));
        Assert.Equal(expected, code.Barcode);
        Assert.True(code.Strict);
        Assert.Equal(text.Trim(), code.Raw);
    }

    [Theory]
    [InlineData("057000010101")]   // An order older than OldestOrder.
    [InlineData("158830010101")]   // Twelve digits that do not begin with 0.
    [InlineData("099999010101")]   // An order far above the newest one known.
    public void An_element_in_progress_is_read_whatever_its_order(string text)
    {
        var hints = new OrderHints(Exists: _ => false, Recent: 58830);
        Assert.True(Barcode.TryParse(text, out var inProgress));

        var code = Assert.IsType<ElementCode>(ScanCodes.Classify(text, hints, [inProgress]));
        Assert.Equal(inProgress, code.Barcode);
        Assert.False(code.Strict);

        // Without it in progress it is no element, as today.
        var unknown = Assert.IsType<UnknownCode>(ScanCodes.Classify(text, hints, []));
        Assert.False(unknown.LooksLikeCommand);
        Assert.IsType<UnknownCode>(ScanCodes.Classify(text, hints));
    }
}
