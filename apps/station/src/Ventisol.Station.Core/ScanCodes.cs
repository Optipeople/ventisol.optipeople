namespace Ventisol.Station.Core;

// The command cards Ventisol prints (docs/plan-scan-commands.md §3.1). Which Arbejdsform uses which
// is not decided here: Classify only says what was scanned.
public enum ScanCommand { Start, Pause, Hold, Undo, Print, Reprint, Clear }

// What one scan is. Raw: the scan as it came in, trimmed (not upper-cased), for the log and the screen.
public abstract record ScanCode(string Raw);

// An element label. Strict: it passed Barcode.TryParseScan; false when it was let in only because it
// is one of the station's elements in progress (Barcode.TryParseInProgress).
public sealed record ElementCode(string Raw, Barcode Barcode, bool Strict) : ScanCode(Raw);

public sealed record CommandCode(string Raw, ScanCommand Command) : ScanCode(Raw);

// A pallet label, VS-PL- and exactly 10 digits. Number: the 10 digits, no prefix (yyMMdd + PC digit +
// 3-digit counter, docs/plan-pallet-labels.md §3); PalletId reads it further.
public sealed record PalletCode(string Raw, string Number) : ScanCode(Raw);

// Anything else. LooksLikeCommand: it began VS- (Ukendt kort, or Ukendt pallelabel for VS-PL-);
// false for everything else (Ukendt stregkode, as before).
public sealed record UnknownCode(string Raw, bool LooksLikeCommand) : ScanCode(Raw);

public static class ScanCodes
{
    public const string Prefix = "VS-";
    public const string PalletPrefix = "VS-PL-";
    public const int PalletDigits = 10;

    // The command registry: every word Ventisol prints after VS-. A new word goes here and into the
    // table in docs/plan-scan-commands.md §3.1. VS-SHIPPED and VS-HOLD-<WORD> are not words yet.
    public static readonly IReadOnlyDictionary<string, ScanCommand> Commands = new Dictionary<string, ScanCommand>
    {
        ["START"] = ScanCommand.Start,
        ["PAUSE"] = ScanCommand.Pause,
        ["HOLD"] = ScanCommand.Hold,
        ["UNDO"] = ScanCommand.Undo,
        ["PRINT"] = ScanCommand.Print,
        ["REPRINT"] = ScanCommand.Reprint,
        ["CLEAR"] = ScanCommand.Clear,
    };

    // A new scan. Digits go by today's element rules: Barcode.TryParseScan, else Barcode.TryParseInProgress
    // with the station's elements in progress (and the paused ones), so one can always be scanned out.
    // A VS payload goes by the registry. The separators may arrive as + instead of - (a Zebra cradle in
    // keyboard mode on a Danish layout types the US - key as +), and the case does not matter.
    public static ScanCode Classify(string? text, OrderHints? hints, IEnumerable<Barcode>? inProgress = null)
    {
        var raw = text?.Trim() ?? "";
        var payload = raw.ToUpperInvariant();

        if (payload.StartsWith("VS-", StringComparison.Ordinal) || payload.StartsWith("VS+", StringComparison.Ordinal))
        {
            payload = payload.Replace('+', '-');
            if (payload.StartsWith(PalletPrefix, StringComparison.Ordinal))
            {
                var number = payload[PalletPrefix.Length..];
                return number.Length == PalletDigits && number.All(char.IsAsciiDigit)
                    ? new PalletCode(raw, number)
                    : new UnknownCode(raw, LooksLikeCommand: true);
            }
            return Commands.TryGetValue(payload[Prefix.Length..], out var command)
                ? new CommandCode(raw, command)
                : new UnknownCode(raw, LooksLikeCommand: true);
        }

        if (Barcode.TryParseScan(raw, out var barcode, hints)) return new ElementCode(raw, barcode, Strict: true);
        if (Barcode.TryParseInProgress(raw, inProgress ?? [], out barcode, hints)) return new ElementCode(raw, barcode, Strict: false);
        return new UnknownCode(raw, LooksLikeCommand: false);
    }
}
