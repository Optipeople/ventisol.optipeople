namespace Ventisol.Station.Core.Documents;

// The production document ("Produktionsliste") 3E writes for an order, as read from its PDF.
// See docs/order-documents.md for the layout. Every part can be missing: a page laid out in a way
// the parser doesn't know gives what it could read, and Problems says what it couldn't.
public sealed record OrderDocument(
    string? FilePath,
    int PageCount,
    OrderDocumentHeader Header,
    IReadOnlyList<OrderPosition> Positions,
    IReadOnlyList<string> Problems)
{
    public static OrderDocument Empty(string? filePath, int pageCount, string problem) =>
        new(filePath, pageCount, OrderDocumentHeader.Empty, [], [problem]);

    // The position a barcode belongs to. The PDF numbers positions 1, 2, 3 (never 5.1 in the samples),
    // so sub-position 01 and any other sub-position land on the same position. If a document ever
    // prints a sub-position ("Position: 5.1"), the barcode's sub-position 02 picks it (see Barcode.PositionLabel).
    public OrderPosition? PositionFor(Barcode barcode) => PositionFor(barcode.Position, barcode.SubPosition);

    public OrderPosition? PositionFor(int position, int subPosition = 1)
    {
        int? sub = subPosition <= 1 ? null : subPosition - 1;
        return Positions.FirstOrDefault(p => p.Number == position && p.SubNumber == sub)
            ?? Positions.FirstOrDefault(p => p.Number == position && p.SubNumber is null)
            ?? Positions.FirstOrDefault(p => p.Number == position);
    }
}

// The block at the top of every page. Customer and DeliveryAddress are the lines as printed,
// name first.
public sealed record OrderDocumentHeader(
    int? OrderNumber,
    IReadOnlyList<string> Customer,
    IReadOnlyList<string> DeliveryAddress,
    int? DeliveryWeek,
    DateOnly? Date,
    string? CaseHandler,
    string? PackageInfo,
    string? GlassDelivery,
    string? GlassPallet)
{
    public static OrderDocumentHeader Empty { get; } = new(null, [], [], null, null, null, null, null, null);

    public string? CustomerName => Customer.Count > 0 ? Customer[0] : null;
}

// One position: an element type, made Quantity times. It starts at the top of page PageIndex
// (0-based) and runs over PageCount pages; the pages after the first hold only the rest of the
// cutting list or hardware. Label is the position as printed ("5", or "5.1" should one appear).
public sealed record OrderPosition(
    string Label,
    int Number,
    int? SubNumber,
    string? System,
    string? FrameColour,
    string? SashColour,
    string? SealColour,
    int? Quantity,
    string? FrameHoles,
    IReadOnlyList<string> Notes,
    IReadOnlyList<OrderField> Fields,
    string? Scale,
    decimal? WeightKg,
    ElementSize? SizeWithoutCoupling,
    IReadOnlyList<CutRow> Cutting,
    IReadOnlyList<FieldBarRow> FieldBars,
    IReadOnlyList<HardwareRow> Hardware,
    IReadOnlyList<HardwareRow> Accessories,
    int PageIndex,
    int PageCount,
    PdfBox? Drawing);

// "Mål u/kobling: 1485,0 * 1380,0": width and height in mm, without coupling profiles.
public sealed record ElementSize(decimal Width, decimal Height, string Text);

// A field (Felt) of the element: its opening, the sash size, the glass and the panes.
// GlassType holds the lines as printed: the glass, then "indv.", "midt.", "udv." and any panel line.
public sealed record OrderField(
    string Number,
    string? Opening,
    string? FrameSize,
    IReadOnlyList<string> GlassType,
    IReadOnlyList<GlassPane> Panes,
    IReadOnlyList<string> Seals);

// One line of Stk / Glasmål / Glasliste for a field. A door field can have two (glass above a panel).
public sealed record GlassPane(int? Quantity, string? Size, string? GlassList);

// A line of "Afkortning". Section is the heading it sits under (Karm, Ramme, Sprosse ...).
// Width is the "Bredde" column some sections have. Side: Un, Ov, Ve, Hø, Lp, Lod., Van. ...
// Lengths stay as printed ("1491,0").
public sealed record CutRow(
    string Section,
    string Profile,
    string? Width,
    int? Quantity,
    string? Length,
    string? Side,
    string? Steel,
    string? SteelLength,
    string? Field,
    string? Clearance);

// A line of the "Felt / Beskrivelse / Farve" table (glazing bars laid in a field).
public sealed record FieldBarRow(string? Field, string Description, string? Colour, string? Side, string? Length);

// A line of "Beskrivelse" (hardware), "Tilbehør" (accessories) or a later table laid out the same
// way, such as "Tilsætningsprofil". Group is the heading it sits under.
public sealed record HardwareRow(string Group, string Description, string? Colour, string? Quantity, string? Size, string? Mounting, string? Placement);

// A rectangle on a PDF page in PDF points, origin at the bottom left as in the PDF itself,
// with the page's size so a viewer can crop the rendered page: TopFromTop is the distance from
// the page's top edge.
public sealed record PdfBox(double Left, double Bottom, double Right, double Top, double PageWidth, double PageHeight)
{
    public double Width => Right - Left;
    public double Height => Top - Bottom;
    public double TopFromTop => PageHeight - Top;
}
