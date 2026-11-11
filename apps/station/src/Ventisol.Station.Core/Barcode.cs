using System.Diagnostics.CodeAnalysis;

namespace Ventisol.Station.Core;

// What the station knows about order numbers, to settle a 14-digit label that both layouts can read.
// Exists: whether an order is known to exist (an order PDF in the 3E folder); false when unknown.
// Recent: an order number from the work going on now, such as the last element scanned.
public sealed record OrderHints(Func<int, bool>? Exists = null, int? Recent = null);

// The 12-digit label barcode on every element, e.g. 058556050103:
// a leading 0, the 5-digit order number, position, sub-position and piece number.
// Profile labels from the saw (Schirmer) carry 14 digits in one of two layouts, both read as their element:
//   05883003010114  order first:    0 + order + position + sub-position + piece + profile number
//   03058830010105  position first: position + 0 + order + sub-position + piece + profile number
// Both of these are order 58830, Pos. 3, piece 1. See Element for how the layout is chosen.
public sealed record Barcode(string Raw, int Order, int Position, int SubPosition, int Piece)
{
    // Orders in production in November 2026 were 587xx-588xx, and order numbers only grow. When a label
    // could be read both ways, a reading with an order below this was never the right one.
    public const int OldestOrder = 58000;

    public static bool TryParse(string? text, [NotNullWhen(true)] out Barcode? barcode, OrderHints? hints = null)
    {
        barcode = null;
        var raw = text?.Trim();
        if (raw is null || !raw.All(char.IsAsciiDigit)) return false;

        // Some scans arrive without the leading 0. Put it back, but only when the 11 digits start with
        // the order number (never 0): 11 digits starting with 0 lost a digit elsewhere and would read as
        // the wrong order, position or piece. The same for 13 digits of a 14-digit label.
        if (raw.Length is 11 or 13 && raw[0] != '0') raw = "0" + raw;
        if (raw.Length == 14)
        {
            if (Element(raw, hints) is not { } element) return false;
            raw = element;
        }
        if (raw.Length != 12) return false;

        barcode = new Barcode(
            raw,
            Order: int.Parse(raw.AsSpan(1, 5)),
            Position: int.Parse(raw.AsSpan(6, 2)),
            SubPosition: int.Parse(raw.AsSpan(8, 2)),
            Piece: int.Parse(raw.AsSpan(10, 2)));
        return true;
    }

    // The 12-digit element of a 14-digit profile label, or null if neither layout fits.
    // Order first fits when it starts with 0 and then the order (never 0). Position first fits when the
    // third digit is the 0 before the order and the position is not 00. Many labels fit only one way.
    // Both fit when the position is below 10 in the position-first layout (03058830010105 also reads as
    // order 30588), or when the order's second digit is 0 in the order-first layout (60xxx, 70xxx ...).
    // Then, in turn: a reading whose order is older than OldestOrder loses; an order that exists beats
    // one that doesn't; the order nearer to the work going on now wins; else the lower order wins, since
    // the wrong reading is mostly far above the orders in production.
    static string? Element(string raw, OrderHints? hints)
    {
        var orderFirst = raw[0] == '0' && raw[1] != '0' ? raw[..12] : null;
        var positionFirst = raw[2] == '0' && raw[3] != '0' && raw[..2] != "00" ? "0" + raw[3..8] + raw[..2] + raw[8..12] : null;
        if (orderFirst is null || positionFirst is null) return orderFirst ?? positionFirst;

        int a = int.Parse(raw.AsSpan(1, 5)), b = int.Parse(raw.AsSpan(3, 5));
        if ((a >= OldestOrder) != (b >= OldestOrder)) return a >= OldestOrder ? orderFirst : positionFirst;
        if (hints?.Exists is { } exists && exists(a) != exists(b)) return exists(a) ? orderFirst : positionFirst;
        if (hints?.Recent is { } recent && Math.Abs(a - recent) != Math.Abs(b - recent))
            return Math.Abs(a - recent) < Math.Abs(b - recent) ? orderFirst : positionFirst;
        return a <= b ? orderFirst : positionFirst;
    }

    // "Pos. 5.1" as printed on the label. Sub-position 01 is the position itself.
    public string PositionLabel => SubPosition <= 1 ? $"Pos. {Position}" : $"Pos. {Position}.{SubPosition - 1}";
}
