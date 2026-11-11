using System.Diagnostics.CodeAnalysis;

namespace Ventisol.Station.Core;

// The 12-digit label barcode on every element, e.g. 058556050103:
// a leading 0, the 5-digit order number, position, sub-position and piece number.
public sealed record Barcode(string Raw, int Order, int Position, int SubPosition, int Piece)
{
    public static bool TryParse(string? text, [NotNullWhen(true)] out Barcode? barcode)
    {
        barcode = null;
        var raw = text?.Trim();
        if (raw is null || !raw.All(char.IsAsciiDigit)) return false;

        // Some scans arrive without the leading 0. Put it back, but only when the 11 digits start with
        // the order number (never 0): 11 digits starting with 0 lost a digit elsewhere and would read as
        // the wrong order, position or piece.
        if (raw.Length == 11 && raw[0] != '0') raw = "0" + raw;
        if (raw.Length != 12) return false;

        barcode = new Barcode(
            raw,
            Order: int.Parse(raw.AsSpan(1, 5)),
            Position: int.Parse(raw.AsSpan(6, 2)),
            SubPosition: int.Parse(raw.AsSpan(8, 2)),
            Piece: int.Parse(raw.AsSpan(10, 2)));
        return true;
    }

    // "Pos. 5.1" as printed on the label. Sub-position 01 is the position itself.
    public string PositionLabel => SubPosition <= 1 ? $"Pos. {Position}" : $"Pos. {Position}.{SubPosition - 1}";
}
