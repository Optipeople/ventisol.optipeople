using System.Diagnostics.CodeAnalysis;

namespace Ventisol.Station.Core;

// What the station knows about order numbers, to settle a 14-digit label that both layouts can read.
// Exists: whether an order is known to exist (an order PDF in the 3E folder); false when unknown.
// Recent: an order number from the work going on now, such as the last element scanned.
// Newest: the highest order number known to exist (the newest order PDF); null when unknown.
public sealed record OrderHints(Func<int, bool>? Exists = null, int? Recent = null, int? Newest = null);

// The 12-digit label barcode on every element, e.g. 058556050103:
// a leading 0, the 5-digit order number, position, sub-position and piece number.
// Profile labels from the saw (Schirmer) carry 14 digits in one of two layouts, both read as their element:
//   05883003010114  order first:    0 + order + position + sub-position + piece + profile number
//   03058830010105  position first: position + 0 + order + sub-position + piece + profile number
// Both of these are order 58830, Pos. 3, piece 1. See Element for how the layout is chosen.
public sealed record Barcode(string Raw, int Order, int Position, int SubPosition, int Piece)
{
    // Orders in production in November 2026 were 587xx-588xx, and order numbers only grow. When a label
    // could be read both ways, a reading with an order below this was never the right one. A new scan
    // (TryParseScan) with an order below it is not an element at all, unless the order is known.
    public const int OldestOrder = 58000;

    // A new scan (TryParseScan) with an order more than this above the newest order the station knows
    // of is not an element either: a retail code with a 0 put in front reads as an order far above the
    // ones in production (7310865004703 as order 73108). About a year of orders at the pace of 2026.
    // The limit follows the orders as they grow, and there is none at all while the station knows no
    // order, so it can never shut real labels out.
    public const int NewestOrderMargin = 1000;

    // A barcode that is already stored: an outbox file, a journal line, a row in OptiCloud. Anything
    // with the digits of an element is read, whatever its order: it was a scan once, and a rule made
    // later must not drop it.
    public static bool TryParse(string? text, [NotNullWhen(true)] out Barcode? barcode, OrderHints? hints = null) =>
        TryParse(text, out barcode, hints, incoming: false);

    // A scan coming in from a scanner. What else gets scanned on a factory floor is the retail code
    // on a box (EAN-13 and UPC-A are 13 and 12 digits too), so here 12 digits must begin with the 0,
    // and the order must be OldestOrder or later and at most NewestOrderMargin above the newest order
    // known (hints.Recent, hints.Newest), or one the documents folder knows (hints.Exists): a remake of
    // an older order is still an element.
    public static bool TryParseScan(string? text, [NotNullWhen(true)] out Barcode? barcode, OrderHints? hints = null) =>
        TryParse(text, out barcode, hints, incoming: true);

    // A scan coming in at a station that has an element in progress: when the scan is that very
    // element, it is its Out, whatever its order. It was taken once (by an older version, or under
    // other hints) and must be able to end. False for any other scan: those go by TryParseScan.
    public static bool TryParseInProgress(string? text, Barcode? inProgress, [NotNullWhen(true)] out Barcode? barcode, OrderHints? hints = null)
    {
        barcode = null;
        if (inProgress is null || !TryParse(text, out var read, hints, incoming: false) || read.Raw != inProgress.Raw) return false;
        barcode = read;
        return true;
    }

    static bool TryParse(string? text, [NotNullWhen(true)] out Barcode? barcode, OrderHints? hints, bool incoming)
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
        var order = int.Parse(raw.AsSpan(1, 5));
        if (incoming)
        {
            // The order has five digits, not six.
            if (raw[0] != '0') return false;
            if (hints?.Exists?.Invoke(order) != true)
            {
                if (order < OldestOrder) return false;
                if (NewestKnown(hints) is { } newest && order > newest + NewestOrderMargin) return false;
            }
        }

        barcode = new Barcode(
            raw,
            Order: order,
            Position: int.Parse(raw.AsSpan(6, 2)),
            SubPosition: int.Parse(raw.AsSpan(8, 2)),
            Piece: int.Parse(raw.AsSpan(10, 2)));
        return true;
    }

    // The newest order the hints know of, never below OldestOrder; null when they know none.
    static int? NewestKnown(OrderHints? hints) =>
        hints is null or { Recent: null, Newest: null } ? null : Math.Max(OldestOrder, Math.Max(hints.Recent ?? 0, hints.Newest ?? 0));

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
