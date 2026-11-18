using System.Globalization;

namespace Ventisol.Station.Core.Documents;

// What the station screen shows of an element's document, as text ready to put on screen: the header,
// the key facts, each field, the cutting list and the hardware. Empty values are left out, and a
// table column that is empty in every row is hidden.
public sealed record ElementSheet(
    string Order,
    string? Position,
    string Piece,
    string? Customer,
    string? DeliveryWeek,
    string? System,
    IReadOnlyList<SheetFact> Facts,
    IReadOnlyList<SheetField> Fields,
    IReadOnlyList<string> Notes,
    SheetCutting Cutting,
    SheetParts Parts,
    IReadOnlyList<SheetPartRow> AddOnProfiles)
{
    static readonly CultureInfo Da = CultureInfo.GetCultureInfo("da-DK");

    // From the barcode alone, when there is no document (or no position in it).
    public static ElementSheet For(Barcode barcode, OrderDocument? doc = null, OrderPosition? position = null)
    {
        var header = doc?.Header;
        var piece = position?.Quantity is { } q ? $"{barcode.Piece} af {q}" : barcode.Piece.ToString(Da);
        return new ElementSheet(
            barcode.Order.ToString(Da),
            position?.Label ?? PositionOf(barcode),
            piece,
            header?.CustomerName,
            header?.DeliveryWeek?.ToString(Da),
            position?.System,
            position is null ? [] : FactsOf(position),
            position is null ? [] : [.. position.Fields.Select(FieldOf)],
            position?.Notes ?? [],
            position is null ? SheetCutting.None : CuttingOf(position),
            position is null ? SheetParts.None : PartsOf(position),
            position is null ? [] : AddOnProfilesOf(position));
    }

    // Tilsætningsprofiler are easy to forget, so the screen shows them on their own, in warning
    // colours, instead of as a few lines in the parts table.
    public static bool IsAddOnProfile(HardwareRow r) => r.Group.StartsWith("Tilsætningsprofil", StringComparison.OrdinalIgnoreCase);

    static List<SheetPartRow> AddOnProfilesOf(OrderPosition p) =>
        [.. p.Accessories.Where(IsAddOnProfile).Select(r => new SheetPartRow(false, r.Description, r.Quantity, r.Colour, r.Size, r.Mounting, r.Placement))];

    // "5", or "5.1" for sub-position 02, as on the label.
    static string PositionOf(Barcode b) => b.SubPosition <= 1 ? b.Position.ToString(Da) : $"{b.Position}.{b.SubPosition - 1}";

    static List<SheetFact> FactsOf(OrderPosition p)
    {
        var facts = new List<SheetFact>();
        if (p.SizeWithoutCoupling is { } size)
            facts.Add(new("Mål u/kobling", $"{Mm(size.Width)} × {Mm(size.Height)}", "mm, bredde × højde"));
        if (p.WeightKg is { } kg) facts.Add(new("Vægt", $"{kg.ToString("0.#", Da)} kg", "pr. element"));
        Add(facts, "Farve karm", p.FrameColour);
        Add(facts, "Farve ramme", p.SashColour);
        Add(facts, "Farve tætning", p.SealColour);
        Add(facts, "Karmhuller", p.FrameHoles);
        return facts;
    }

    static void Add(List<SheetFact> facts, string label, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value)) facts.Add(new(label, value.Trim(), null));
    }

    static string Mm(decimal v) => v.ToString(v == Math.Round(v) ? "0" : "0.#", Da);

    // "1415,0 * 1310,0" as "1415,0 × 1310,0".
    public static string Size(string? text) => (text ?? "").Replace(" * ", " × ").Replace("*", " × ").Trim();

    static SheetField FieldOf(OrderField f)
    {
        var panes = f.Panes
            .Where(p => p.Size is not null || p.Quantity is not null)
            .Select(p => string.Join("  ·  ", new[] { p.Quantity is { } n ? $"{n} stk." : null, p.Size is { } s ? Size(s) : null, p.GlassList }
                .Where(x => !string.IsNullOrWhiteSpace(x))))
            .ToList();
        return new SheetField(
            $"Felt {f.Number}",
            f.Opening,
            string.IsNullOrWhiteSpace(f.FrameSize) ? null : Size(f.FrameSize),
            f.GlassType.Count > 0 ? f.GlassType[0] : null,
            [.. f.GlassType.Skip(1)],
            panes,
            f.Seals);
    }

    static SheetCutting CuttingOf(OrderPosition p)
    {
        var rows = new List<SheetCutRow>();
        string? section = null;
        foreach (var r in p.Cutting)
        {
            if (r.Section != section)
            {
                section = r.Section;
                rows.Add(SheetCutRow.Heading(r.Section));
            }
            rows.Add(new SheetCutRow(false, r.Profile, r.Width, r.Quantity?.ToString(Da), r.Length, r.Side, r.Steel, r.SteelLength, r.Field, r.Clearance));
        }
        return new SheetCutting(rows,
            ShowWidth: p.Cutting.Any(r => !string.IsNullOrWhiteSpace(r.Width)),
            ShowSteel: p.Cutting.Any(r => !string.IsNullOrWhiteSpace(r.Steel) || !string.IsNullOrWhiteSpace(r.SteelLength)),
            ShowField: p.Cutting.Any(r => !string.IsNullOrWhiteSpace(r.Field)),
            ShowClearance: p.Cutting.Any(r => !string.IsNullOrWhiteSpace(r.Clearance)));
    }

    static SheetParts PartsOf(OrderPosition p)
    {
        var all = p.Hardware.Concat(p.Accessories.Where(r => !IsAddOnProfile(r))).ToList();
        var rows = new List<SheetPartRow>();
        string? group = null;
        foreach (var r in all)
        {
            if (r.Group != group)
            {
                group = r.Group;
                rows.Add(SheetPartRow.Heading(GroupName(r.Group)));
            }
            rows.Add(new SheetPartRow(false, r.Description, r.Quantity, r.Colour, r.Size, r.Mounting, r.Placement));
        }
        if (p.FieldBars.Count > 0)
        {
            rows.Add(SheetPartRow.Heading("Sprosser"));
            foreach (var b in p.FieldBars)
                rows.Add(new SheetPartRow(false, b.Description, null, b.Colour, b.Length, null, BarPlace(b)));
        }
        var parts = all.Concat(p.FieldBars.Select(b => new HardwareRow("", b.Description, b.Colour, null, b.Length, null, BarPlace(b)))).ToList();
        return new SheetParts(rows,
            ShowColour: parts.Any(r => !string.IsNullOrWhiteSpace(r.Colour)),
            ShowSize: parts.Any(r => !string.IsNullOrWhiteSpace(r.Size)),
            ShowMounting: parts.Any(r => !string.IsNullOrWhiteSpace(r.Mounting)),
            ShowPlacement: parts.Any(r => !string.IsNullOrWhiteSpace(r.Placement)));
    }

    // "Felt 1 · Lod.": the field and the bar's direction.
    static string? BarPlace(FieldBarRow b)
    {
        var text = string.Join(" · ", new[] { b.Field is { Length: > 0 } f ? $"Felt {f}" : null, b.Side }.Where(x => !string.IsNullOrWhiteSpace(x)));
        return text.Length > 0 ? text : null;
    }

    // The PDF heads hardware "Beskrivelse"; on screen it is what it is.
    static string GroupName(string group) => group switch
    {
        "Beskrivelse" => "Beslag",
        _ => group,
    };
}

// A key fact on a card: the label, the value big, a quiet line under it.
public sealed record SheetFact(string Label, string Value, string? Detail);

// A field (Felt): its opening, sash size, the glass (first line) with its layers, and the panes.
public sealed record SheetField(
    string Title,
    string? Opening,
    string? FrameSize,
    string? Glass,
    IReadOnlyList<string> GlassLayers,
    IReadOnlyList<string> Panes,
    IReadOnlyList<string> Seals)
{
    public string SealsText => string.Join(", ", Seals);
}

public sealed record SheetCutRow(bool IsHeading, string Profile, string? Width, string? Quantity, string? Length, string? Side,
    string? Steel, string? SteelLength, string? Field, string? Clearance)
{
    public static SheetCutRow Heading(string section) => new(true, section, null, null, null, null, null, null, null, null);
}

public sealed record SheetCutting(IReadOnlyList<SheetCutRow> Rows, bool ShowWidth, bool ShowSteel, bool ShowField, bool ShowClearance)
{
    public static SheetCutting None { get; } = new([], false, false, false, false);
}

public sealed record SheetPartRow(bool IsHeading, string Description, string? Quantity, string? Colour, string? Size, string? Mounting, string? Placement)
{
    public static SheetPartRow Heading(string group) => new(true, group, null, null, null, null, null);
}

public sealed record SheetParts(IReadOnlyList<SheetPartRow> Rows, bool ShowColour, bool ShowSize, bool ShowMounting, bool ShowPlacement)
{
    public static SheetParts None { get; } = new([], false, false, false, false);
}
