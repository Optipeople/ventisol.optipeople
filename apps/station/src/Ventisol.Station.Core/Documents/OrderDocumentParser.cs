using System.Globalization;
using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace Ventisol.Station.Core.Documents;

// Reads a "Produktionsliste" PDF from 3E into an OrderDocument (layout: docs/order-documents.md).
// The PDF is text and vector lines, no form fields, so everything is found by position: labels and
// table heads are looked up by their text, and values by where they sit relative to them. Anything
// it doesn't recognise is left out and noted in Problems; it never throws on a bad file.
public static partial class OrderDocumentParser
{
    public static OrderDocument Parse(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return Parse(stream, path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return OrderDocument.Empty(path, 0, $"Could not read the file: {ex.Message}");
        }
    }

    public static OrderDocument Parse(byte[] pdf, string? path = null)
    {
        using var stream = new MemoryStream(pdf, writable: false);
        return Parse(stream, path);
    }

    public static OrderDocument Parse(Stream pdf, string? path = null)
    {
        PdfDocument doc;
        try { doc = PdfDocument.Open(pdf); }
        catch (Exception ex) { return OrderDocument.Empty(path, 0, $"Not a readable PDF: {ex.Message}"); }

        using (doc)
        {
            var problems = new List<string>();
            int pageCount;
            try { pageCount = doc.NumberOfPages; }
            catch (Exception ex) { return OrderDocument.Empty(path, 0, $"Not a readable PDF: {ex.Message}"); }

            var pages = new List<PageText?>();
            for (var i = 0; i < pageCount; i++)
            {
                try { pages.Add(PageText.Read(doc.GetPage(i + 1), i)); }
                catch (Exception ex)
                {
                    pages.Add(null);
                    problems.Add($"Page {i + 1}: could not be read ({ex.Message})");
                }
            }

            OrderDocumentHeader header = OrderDocumentHeader.Empty;
            try { header = ReadHeader(pages, problems); }
            catch (Exception ex) { problems.Add($"Header: {ex.Message}"); }

            var positions = new List<OrderPosition>();
            try { positions = ReadPositions(pages, problems); }
            catch (Exception ex) { problems.Add($"Positions: {ex.Message}"); }

            if (positions.Count == 0) problems.Add("No positions found");
            return new OrderDocument(path, pageCount, header, positions, problems);
        }
    }

    // ----- Header

    static OrderDocumentHeader ReadHeader(List<PageText?> pages, List<string> problems)
    {
        var page = pages.FirstOrDefault(p => p is not null && p.Find("Ordrer", "nr.:") is not null)
            ?? pages.FirstOrDefault(p => p is not null);
        if (page is null) return OrderDocumentHeader.Empty;

        var top = page.Lines.Where(l => l.Y > page.HeaderRuleY).ToList();
        var orderText = page.ValueAfter(top, "Ordrer", "nr.:");
        var order = orderText is null ? (int?)null : ParseInt(orderText);
        if (order is null) problems.Add("Header: no order number");

        var weekText = page.ValueAfter(top, "Lev.", "uge:");
        var dateText = page.ValueAfter(top, "Dato:");
        DateOnly? date = DateOnly.TryParseExact(dateText?.Split(' ')[0], ["dd-MM-yyyy", "d-M-yyyy", "dd.MM.yyyy", "dd-MM-yy"],
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

        var side = page.Find(top, "Side:");
        var pakke = page.Find(top, "Pakke", "info.:");
        var caseHandler = page.ValueAfter(top, ["Sagsbeh.:"], stopAt: pakke?.First.Left);
        var packageInfo = page.ValueAfter(top, ["Pakke", "info.:"], stopAt: side?.First.Left);
        var glassDelivery = page.ValueAfter(top, "Glas", "lev.:");
        var glassPallet = page.ValueAfter(top, "Glas", "palle:");
        if (glassPallet is not null && glassPallet.All(c => c is '_' or ' ')) glassPallet = null;

        var kunde = page.Find(top, "Kunde:");
        var levAdr = page.Find(top, "Lev.", "adr.:");
        var bottom = page.Find(top, "Dato:")?.Line.Y ?? page.Find(top, "Sagsbeh.:")?.Line.Y ?? page.HeaderRuleY;
        IReadOnlyList<string> customer = [], delivery = [];
        if (kunde is not null)
            customer = BlockLines(top, kunde.Value.Last.Right + 1, levAdr?.First.Left - 2 ?? kunde.Value.Last.Right + 160, kunde.Value.Line.Y + 2, bottom + 2);
        if (levAdr is not null)
            delivery = BlockLines(top, levAdr.Value.Last.Right + 1, side?.First.Left - 2 ?? levAdr.Value.Last.Right + 190, levAdr.Value.Line.Y + 2, bottom + 2);

        return new OrderDocumentHeader(order, customer, delivery, weekText is null ? null : ParseInt(weekText), date,
            caseHandler, packageInfo, glassDelivery, glassPallet);
    }

    // The text in a box of the header, a line per printed line.
    static List<string> BlockLines(List<Line> lines, double left, double right, double top, double bottom) =>
        [.. lines.Where(l => l.Y <= top && l.Y > bottom)
            .Select(l => Join(l.Words.Where(w => w.Left >= left && w.Left < right)))
            .Where(t => t.Length > 0)];

    // ----- Positions

    static List<OrderPosition> ReadPositions(List<PageText?> pages, List<string> problems)
    {
        var result = new List<OrderPosition>();
        PositionBuilder? current = null;
        foreach (var page in pages)
        {
            if (page is null) { if (current is not null) current.PageCount++; continue; }
            var start = page.Find(page.Body, "Position:");
            if (start is not null && start.Value.First.Left < 120)
            {
                if (current is not null) result.Add(current.Build());
                current = new PositionBuilder(page.Index);
                try { ReadStartPage(page, current); }
                catch (Exception ex) { problems.Add($"Page {page.Index + 1}: {ex.Message}"); }
            }
            else if (current is not null)
            {
                current.PageCount++;
                try { current.Lower(page.Body.Select(l => l.Words).ToList()); }
                catch (Exception ex) { problems.Add($"Page {page.Index + 1}: {ex.Message}"); }
            }
        }
        if (current is not null) result.Add(current.Build());

        foreach (var p in result.Where(p => p.Number <= 0))
            problems.Add($"Page {p.PageIndex + 1}: position number not read");
        return result;
    }

    static void ReadStartPage(PageText page, PositionBuilder pos)
    {
        var body = page.Body;
        var dash = body.SelectMany(l => l.Words).FirstOrDefault(w => w.IsRule('-') && w.Left < 120);
        var feltHead = body.FirstOrDefault(l => l.Has("Åbningsfunktion") || l.Has("Glastype"));
        double dashY = dash?.Bottom
            ?? body.FirstOrDefault(l => l.Words[0].Text == "Afkortning")?.Y + 3
            ?? 0;

        // The scale and weight line and "Mål u/kobling", both at the right above the drawing.
        var skip = new HashSet<Word>();
        var scale = body.SelectMany(l => l.Words).FirstOrDefault(w => ScaleRegex().IsMatch(w.Text));
        if (scale is not null)
        {
            pos.Scale = scale.Text;
            var line = body.First(l => l.Words.Contains(scale));
            var rest = line.Words.Where(w => w.Left >= scale.Left).ToList();
            skip.UnionWith(rest);
            var ca = rest.FindIndex(w => w.Text.Equals("Ca.", StringComparison.OrdinalIgnoreCase));
            if (ca >= 0 && ca + 1 < rest.Count) pos.WeightKg = ParseDecimal(rest[ca + 1].Text);
        }
        var kobling = page.Find(body, "u/kobling:");
        if (kobling is not null)
        {
            var (line, first, last) = kobling.Value;
            var at = line.Words.IndexOf(first);
            var label = at > 0 && first.Left - line.Words[at - 1].Right < 6 ? line.Words[at - 1] : first;
            skip.UnionWith(line.Words.Where(w => w.Left >= label.Left));
            var text = Join(line.Words.Where(w => w.Left > last.Left));
            var m = SizeRegex().Match(text);
            if (m.Success && ParseDecimal(m.Groups[1].Value) is { } width && ParseDecimal(m.Groups[2].Value) is { } height)
                pos.SizeWithoutCoupling = new ElementSize(width, height, $"{m.Groups[1].Value} * {m.Groups[2].Value}");
        }

        var feltAnchors = Anchors(feltHead, ("Felt", 199), ("Åbningsfunktion", 223), ("Rammemål", 365), ("Glastype", 439),
            ("Stk", 593), ("Glasmål", 628), ("Glasliste", 701), ("Tætning", 756));
        var feltLeft = feltAnchors[0];

        // Left column: System, Position:, colours, Antal:, Karmhuller:, and bold notes.
        foreach (var line in body)
        {
            var words = line.Words.Where(w => w.Bottom > dashY + 0.5 && !skip.Contains(w)).ToList();
            var left = words.Where(w => w.Left < feltLeft - 4).ToList();
            if (left.Count == 0) continue;
            ReadLeftLine(pos, left, words, skip);
        }

        // Felt oplysninger
        if (feltHead is not null)
        {
            var rows = body
                .Select(l => l.Words.Where(w => w.Bottom > dashY + 0.5 && w.Bottom < feltHead.Y - 1 && w.Left >= feltLeft - 4 && !skip.Contains(w)).ToList())
                .Where(ws => ws.Count > 0)
                .ToList();
            ReadFields(pos, rows, feltAnchors);
        }

        // The drawing: every stroked line and image near the top right of the lower half, the
        // turned dimension text, and the plain text among them (field numbers, sizes).
        var limit = (dash?.Bottom ?? page.Height) + 20;
        var parts = page.Strokes.Concat(page.Images).Where(r => r.Left >= 400 && r.Top <= limit).ToList();
        double drawLeft = 575;
        if (parts.Count > 0)
        {
            drawLeft = Math.Min(drawLeft, parts.Min(r => r.Left));
            parts.AddRange(page.Rotated.Where(r => r.Left >= drawLeft - 4 && r.Top <= limit));
            parts.AddRange(body.SelectMany(l => l.Words)
                .Where(w => w.Bottom < dashY && w.Left >= drawLeft - 4 && !skip.Contains(w))
                .Select(w => new Box(w.Left, w.Bottom, w.Right, w.Top)));
            const double pad = 3;
            pos.Drawing = new PdfBox(
                Math.Max(0, parts.Min(r => r.Left) - pad),
                Math.Max(0, parts.Min(r => r.Bottom) - pad),
                Math.Min(page.Width, parts.Max(r => r.Right) + pad),
                Math.Min(page.Height, parts.Max(r => r.Top) + pad),
                page.Width, page.Height);
        }

        // Below the rule: cutting list, glazing bars, hardware, accessories.
        var lower = body
            .Select(l => l.Words.Where(w => w.Bottom <= dashY + 0.5 && w.Left < drawLeft - 4 && !skip.Contains(w)).ToList())
            .Where(ws => ws.Count > 0)
            .ToList();
        pos.Lower(lower);
    }

    static void ReadLeftLine(PositionBuilder pos, List<Word> left, List<Word> all, HashSet<Word> used)
    {
        var first = left[0];
        if (first.Text == "System")
        {
            pos.System ??= NullIfEmpty(Join(left.Skip(1)));
            return;
        }

        var colon = left.FindIndex(w => w.Text.EndsWith(':'));
        if (colon is >= 0 and < 3 && !first.Bold)
        {
            var label = Join(left.Take(colon + 1)).ToLowerInvariant();
            var value = NullIfEmpty(Join(left.Skip(colon + 1)));
            switch (label)
            {
                case "position:":
                    pos.Label = value ?? "";
                    var m = value is null ? Match.Empty : PositionRegex().Match(value);
                    if (m.Success)
                    {
                        pos.Number = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                        pos.SubNumber = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : null;
                    }
                    break;
                case "farve karm:": pos.FrameColour = value; break;
                case "farve ramme:": pos.SashColour = value; break;
                case "farve tætning:": pos.SealColour = value; break;
                case "antal:": pos.Quantity = value is null ? null : ParseInt(value); break;
                case "karmhuller:": pos.FrameHoles = value; break;
                default: pos.Notes.Add(value is null ? Join(left.Take(colon + 1)) : $"{Join(left.Take(colon + 1))} {value}"); break;
            }
            return;
        }

        // A note in bold: the left words, and on along the line while the text runs on.
        var note = new List<Word>(left);
        foreach (var w in all.Where(w => w.Left > left[^1].Left).OrderBy(w => w.Left))
        {
            if (w.Left - note[^1].Right > 6) break;
            note.Add(w);
        }
        used.UnionWith(note);
        var text = Join(note);
        if (text.Length > 0 && !text.All(c => c is '_' or '-' or '.')) pos.Notes.Add(text);
    }

    static void ReadFields(PositionBuilder pos, List<List<Word>> rows, double[] a)
    {
        FieldBuilder? field = null;
        foreach (var row in rows)
        {
            var cols = new List<Word>[8];
            for (var i = 0; i < 8; i++) cols[i] = [];
            foreach (var w in row) cols[Column(a, w.Left, 8)].Add(w);

            var number = Join(cols[0]);
            if (FieldNumberRegex().IsMatch(number))
            {
                field = new FieldBuilder(number);
                pos.Fields.Add(field);
            }
            if (field is null) continue;

            Append(ref field.Opening, Join(cols[1]));
            Append(ref field.FrameSize, Join(cols[2]));
            var glass = Join(cols[3]);
            if (glass.Length > 0) field.GlassType.Add(glass);

            var stk = Join(cols[4]);
            var size = Join(cols[5]);
            var list = NullIfEmpty(Join(cols[6]));
            if (stk.Length > 0 || size.Length > 0)
                field.Panes.Add(new GlassPane(ParseInt(stk), NullIfEmpty(size), list));
            else if (list is not null)
            {
                var open = field.Panes.FindIndex(p => p.GlassList is null);
                if (open >= 0) field.Panes[open] = field.Panes[open] with { GlassList = list };
                else field.Panes.Add(new GlassPane(null, null, list));
            }

            var seal = Join(cols[7]);
            if (seal.Length > 0) field.Seals.Add(seal);
        }
    }

    // ----- Builders

    sealed class FieldBuilder(string number)
    {
        public string Number = number;
        public string? Opening, FrameSize;
        public readonly List<string> GlassType = [];
        public readonly List<GlassPane> Panes = [];
        public readonly List<string> Seals = [];

        public OrderField Build() => new(Number, Opening, FrameSize, GlassType, Panes, Seals);
    }

    enum Section { None, Cutting, FieldBars, Hardware, Accessories }

    sealed class PositionBuilder(int pageIndex)
    {
        public readonly int PageIndex = pageIndex;
        public int PageCount = 1;
        public string Label = "";
        public int Number;
        public int? SubNumber, Quantity;
        public string? System, FrameColour, SashColour, SealColour, FrameHoles, Scale;
        public decimal? WeightKg;
        public ElementSize? SizeWithoutCoupling;
        public PdfBox? Drawing;
        public readonly List<string> Notes = [];
        public readonly List<FieldBuilder> Fields = [];
        public readonly List<CutRow> Cutting = [];
        public readonly List<FieldBarRow> FieldBars = [];
        public readonly List<HardwareRow> Hardware = [];
        public readonly List<HardwareRow> Accessories = [];

        // Where the lower part has got to; carried over to the next page, where a table can go on.
        Section _section;
        string _cutGroup = "", _group = "Tilbehør";
        double? _widthAnchor;
        double[] _cut = [137, 181, 318, 366, 410, 450];
        double[] _bars = [32, 60, 163];
        double[] _hardware = [188, 258, 300, 357, 428];
        static readonly double[] AccessoryAnchors = [188, 244, 287, 344, 413];

        public void Lower(List<List<Word>> lines)
        {
            foreach (var raw in lines)
            {
                var words = raw.Where(w => !w.IsRule('-') && !w.IsRule('_') && w.Text.Any(char.IsLetterOrDigit)).OrderBy(w => w.Left).ToList();
                if (words.Count == 0) continue;
                var first = words[0];

                if (first.Bold && first.Text == "Afkortning")
                {
                    _section = Section.Cutting;
                    _cutGroup = "";
                    _widthAnchor = null;
                    var lengths = words.Where(w => w.Text == "Længde:").ToList();
                    _cut = [At(words, "Stk.:", _cut[0]), lengths.Count > 0 ? lengths[0].Left : _cut[1], At(words, "Stål:", _cut[2]),
                        lengths.Count > 1 ? lengths[1].Left : _cut[3], At(words, "Felt", _cut[4]), At(words, "Lysm.", _cut[5])];
                    continue;
                }
                if (first.Bold && first.Text == "Felt" && words.Any(w => w.Text == "Beskrivelse"))
                {
                    _section = Section.FieldBars;
                    _bars = [first.Left, At(words, "Beskrivelse", _bars[1]), At(words, "Farve", _bars[2])];
                    continue;
                }
                if (first.Bold && first.Text == "Beskrivelse")
                {
                    _section = Section.Hardware;
                    _hardware = [At(words, "Farve", _hardware[0]), At(words, "Antal", _hardware[1]), At(words, "Mål", _hardware[2]),
                        At(words, "Mont./Løs", _hardware[3]), At(words, "Placering", _hardware[4])];
                    continue;
                }
                if (first.Bold && first.Text == "Tilbehør")
                {
                    _section = Section.Accessories;
                    _group = "Tilbehør";
                    continue;
                }
                // Another heading after the hardware, such as "Tilsætningsprofil": its lines are
                // laid out as Tilbehør, so they go with the accessories under their own group.
                if (_section is Section.Hardware or Section.Accessories && first.Left < 60 && words.All(w => w.Bold))
                {
                    _section = Section.Accessories;
                    _group = Join(words);
                    continue;
                }

                switch (_section)
                {
                    case Section.Cutting: CutLine(words); break;
                    case Section.FieldBars: BarLine(words); break;
                    case Section.Hardware: Hardware.Add(HardwareLine("Beskrivelse", words, _hardware)); break;
                    case Section.Accessories: Accessories.Add(HardwareLine(_group, words, AccessoryAnchors)); break;
                }
            }
        }

        void CutLine(List<Word> words)
        {
            var stkFrom = _cut[0] - 8;
            if (words[0].Bold && words[0].Left < 60 && !words.Any(w => w.Left >= stkFrom && w.Left < _cut[1] - 8))
            {
                _cutGroup = words[0].Text;
                _widthAnchor = words.Skip(1).FirstOrDefault(w => w.Bold && w.Left < stkFrom)?.Left;
                return;
            }

            var profileEnd = _widthAnchor is { } wa ? wa - 6 : stkFrom;
            string Part(double from, double to) => Join(words.Where(w => w.Left >= from && w.Left < to));
            var profile = Part(double.MinValue, profileEnd);
            var width = _widthAnchor is null ? "" : Part(profileEnd, stkFrom);
            var stk = Part(stkFrom, _cut[1] - 8);
            var lengthWords = words.Where(w => w.Left >= _cut[1] - 8 && w.Left < _cut[2] - 8).ToList();
            var length = lengthWords.Count > 0 && IsNumber(lengthWords[0].Text) ? lengthWords[0].Text : null;
            var side = Join(length is null ? lengthWords : lengthWords.Skip(1));
            Cutting.Add(new CutRow(_cutGroup, profile, NullIfEmpty(width), ParseInt(stk), length, NullIfEmpty(side),
                NullIfEmpty(Part(_cut[2] - 8, _cut[3] - 8)), NullIfEmpty(Part(_cut[3] - 8, _cut[4] - 8)),
                NullIfEmpty(Part(_cut[4] - 8, _cut[5] - 8)), NullIfEmpty(Part(_cut[5] - 8, double.MaxValue))));
        }

        void BarLine(List<Word> words)
        {
            if (words[0].Bold) return;
            var cells = Cells(words);
            var field = Join(cells.Where(c => c.Left < _bars[1] - 6));
            var description = Join(cells.Where(c => c.Left >= _bars[1] - 6 && c.Left < _bars[2] - 6));
            var rest = cells.Where(c => c.Left >= _bars[2] - 6).ToList();
            string? colour = rest.Count > 0 ? rest[0].Text : null;
            var others = rest.Skip(1).ToList();
            var length = others.LastOrDefault(c => IsNumber(c.Text))?.Text;
            var side = Join(others.Where(c => c.Text != length));
            FieldBars.Add(new FieldBarRow(NullIfEmpty(field), description, colour, NullIfEmpty(side), length));
        }

        static HardwareRow HardwareLine(string group, List<Word> words, double[] anchors)
        {
            var cells = Cells(words);
            var parts = new List<string>[6];
            for (var i = 0; i < 6; i++) parts[i] = [];
            foreach (var c in cells)
            {
                var col = 0;
                for (var i = 0; i < anchors.Length; i++)
                    if (c.Left >= anchors[i] - 8) col = i + 1;
                parts[col].Add(c.Text);
            }
            string? P(int i) => NullIfEmpty(string.Join(" ", parts[i]));
            return new HardwareRow(group, P(0) ?? "", P(1), P(2), P(3), P(4), P(5));
        }

        public OrderPosition Build() => new(
            Label, Number, SubNumber, System, FrameColour, SashColour, SealColour, Quantity, FrameHoles, Notes,
            [.. Fields.Select(f => f.Build())], Scale, WeightKg, SizeWithoutCoupling,
            Cutting, FieldBars, Hardware, Accessories, PageIndex, PageCount, Drawing);
    }

    // ----- Text on a page

    internal sealed record Word(string Text, double Left, double Bottom, double Right, double Top, bool Bold)
    {
        public bool IsRule(char c) => Text.Length >= 10 && Text.All(x => x == c);
    }

    internal sealed record Line(double Y, List<Word> Words)
    {
        public bool Has(string text) => Words.Any(w => w.Text == text);
    }

    readonly record struct Box(double Left, double Bottom, double Right, double Top);

    sealed class PageText
    {
        public int Index;
        public double Width, Height, HeaderRuleY;
        public List<Line> Lines = [];
        public List<Line> Body = [];
        public List<Box> Strokes = [], Images = [], Rotated = [];

        public static PageText Read(Page page, int index)
        {
            var letters = Dedupe(page.Letters);
            var words = Words(letters.Where(l => l.TextOrientation == TextOrientation.Horizontal));
            var t = new PageText { Index = index, Width = page.Width, Height = page.Height, Lines = Group(words) };
            t.HeaderRuleY = t.Lines.SelectMany(l => l.Words).FirstOrDefault(w => w.IsRule('_') && w.Text.Length >= 40 && w.Left < 120)?.Bottom
                ?? t.Lines.FirstOrDefault(l => l.Has("Sagsbeh.:"))?.Y - 5
                ?? page.Height * 0.78;
            t.Body = [.. t.Lines.Where(l => l.Y < t.HeaderRuleY - 1)];

            foreach (var p in page.Paths)
                if (p.IsStroked && p.GetBoundingRectangle() is { } r)
                    t.Strokes.Add(new Box(r.Left, r.Bottom, r.Right, r.Top));
            foreach (var img in page.GetImages())
            {
                var r = img.BoundingBox;
                t.Images.Add(new Box(r.Left, r.Bottom, r.Right, r.Top));
            }
            foreach (var l in letters.Where(l => l.TextOrientation != TextOrientation.Horizontal && !string.IsNullOrWhiteSpace(l.Value)))
            {
                var r = l.BoundingBox;
                t.Rotated.Add(new Box(Math.Min(r.Left, r.Right), Math.Min(r.Bottom, r.Top), Math.Max(r.Left, r.Right), Math.Max(r.Bottom, r.Top)));
            }
            return t;
        }

        public (Line Line, Word First, Word Last)? Find(params string[] texts) => Find(Lines, texts);

        public (Line Line, Word First, Word Last)? Find(List<Line> lines, params string[] texts)
        {
            foreach (var line in lines)
                for (var i = 0; i + texts.Length <= line.Words.Count; i++)
                {
                    var match = true;
                    for (var j = 0; j < texts.Length && match; j++)
                        match = string.Equals(line.Words[i + j].Text, texts[j], StringComparison.OrdinalIgnoreCase);
                    if (match) return (line, line.Words[i], line.Words[i + texts.Length - 1]);
                }
            return null;
        }

        public string? ValueAfter(List<Line> lines, params string[] label) => ValueAfter(lines, label, null);

        // The words after a label on its line, up to stopAt (an x) when given.
        public string? ValueAfter(List<Line> lines, string[] label, double? stopAt)
        {
            if (Find(lines, label) is not { } f) return null;
            return NullIfEmpty(Join(f.Line.Words.Where(w => w.Left > f.Last.Left && (stopAt is null || w.Left < stopAt - 1))));
        }
    }

    // Bold text in these PDFs is often the same run drawn twice on the same spot.
    static List<Letter> Dedupe(IReadOnlyList<Letter> letters)
    {
        var seen = new HashSet<(string, long, long)>();
        var kept = new List<Letter>(letters.Count);
        foreach (var l in letters)
            if (seen.Add((l.Value, (long)Math.Round(l.StartBaseLine.X * 2), (long)Math.Round(l.StartBaseLine.Y * 2))))
                kept.Add(l);
        return kept;
    }

    // Letters into words in the order they were drawn: a word ends at a space, or where the next
    // letter doesn't follow on from the last (a jump, a new line, another font). Sorting by x instead
    // would mix two texts that overlap on the page, as a long description running into the colour does.
    static List<Word> Words(IEnumerable<Letter> letters)
    {
        var words = new List<Word>();
        var run = new List<Letter>();

        void Flush()
        {
            if (run.Count == 0) return;
            var text = string.Concat(run.Select(l => l.Value)).Trim();
            if (text.Length > 0)
                words.Add(new Word(text,
                    run.Min(l => Math.Min(l.StartBaseLine.X, l.EndBaseLine.X)),
                    run.Min(l => l.StartBaseLine.Y),
                    run.Max(l => Math.Max(l.StartBaseLine.X, l.EndBaseLine.X)),
                    run.Max(l => Math.Max(l.BoundingBox.Top, l.BoundingBox.Bottom)),
                    (run[0].FontName ?? "").Contains("Bold", StringComparison.OrdinalIgnoreCase)));
            run.Clear();
        }

        foreach (var l in letters)
        {
            if (string.IsNullOrWhiteSpace(l.Value)) { Flush(); continue; }
            if (run.Count > 0)
            {
                var prev = run[^1];
                var gap = l.StartBaseLine.X - prev.EndBaseLine.X;
                var size = Math.Max(1, prev.PointSize);
                if (Math.Abs(l.StartBaseLine.Y - prev.StartBaseLine.Y) > 0.5 || gap > size * 0.15 || gap < -size * 0.15 || l.FontName != prev.FontName)
                    Flush();
            }
            run.Add(l);
        }
        Flush();
        return words;
    }

    // Words into lines, top to bottom: a line takes the words whose baseline is within 1.6 pt.
    static List<Line> Group(List<Word> words)
    {
        var lines = new List<Line>();
        foreach (var w in words.OrderByDescending(w => w.Bottom))
        {
            if (lines.Count > 0 && lines[^1].Y - w.Bottom <= 1.6) lines[^1].Words.Add(w);
            else lines.Add(new Line(w.Bottom, [w]));
        }
        foreach (var l in lines) l.Words.Sort((a, b) => a.Left.CompareTo(b.Left));
        return lines;
    }

    sealed record Cell(string Text, double Left);

    // Words that run on (a space apart) as one cell; a wider gap starts the next column, and so does
    // a word printed over the one before it (a long description running into the colour column).
    static List<Cell> Cells(List<Word> words)
    {
        var cells = new List<Cell>();
        Word? prev = null;
        var parts = new List<Word>();
        foreach (var w in words.OrderBy(w => w.Left))
        {
            if (prev is not null && (w.Left - prev.Right > 5 || w.Left < prev.Right - 1))
            {
                cells.Add(new Cell(Join(parts), parts[0].Left));
                parts.Clear();
            }
            parts.Add(w);
            prev = w;
        }
        if (parts.Count > 0) cells.Add(new Cell(Join(parts), parts[0].Left));
        return cells;
    }

    // The table column a word starting at x falls in, given each column head's left edge.
    static int Column(double[] anchors, double x, int count)
    {
        var col = 0;
        for (var i = 0; i < count && i < anchors.Length; i++)
            if (x >= anchors[i] - 8) col = i;
        return col;
    }

    static double[] Anchors(Line? head, params (string Text, double Default)[] columns) =>
        [.. columns.Select(c => head?.Words.FirstOrDefault(w => w.Text == c.Text)?.Left ?? c.Default)];

    static double At(List<Word> words, string text, double fallback) => words.FirstOrDefault(w => w.Text == text)?.Left ?? fallback;

    static string Join(IEnumerable<Word> words) => string.Join(" ", words.OrderBy(w => w.Left).Select(w => w.Text)).Trim();

    static string Join(IEnumerable<Cell> cells) => string.Join(" ", cells.Select(c => c.Text)).Trim();

    static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    static void Append(ref string? target, string text)
    {
        if (text.Length == 0) return;
        target = target is null ? text : $"{target} {text}";
    }

    static bool IsNumber(string s) => NumberRegex().IsMatch(s);

    static int? ParseInt(string s)
    {
        var m = LeadingIntRegex().Match(s.Trim());
        return m.Success && int.TryParse(m.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : null;
    }

    // Danish decimals: "84,5", "1485,0", "1.485,0".
    internal static decimal? ParseDecimal(string s)
    {
        s = s.Trim();
        if (s.Contains(',')) s = s.Replace(".", "").Replace(',', '.');
        return decimal.TryParse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var d) ? d : null;
    }

    [GeneratedRegex(@"^1:\d+$")]
    private static partial Regex ScaleRegex();

    [GeneratedRegex(@"(\d+(?:[.,]\d+)?)\s*\*\s*(\d+(?:[.,]\d+)?)")]
    private static partial Regex SizeRegex();

    [GeneratedRegex(@"^(\d+)(?:\.(\d+))?")]
    private static partial Regex PositionRegex();

    [GeneratedRegex(@"^\d+(?:[.,]\d+)?$")]
    private static partial Regex NumberRegex();

    [GeneratedRegex(@"^\d+(?:\.\d+)?$")]
    private static partial Regex FieldNumberRegex();

    [GeneratedRegex(@"^\d+")]
    private static partial Regex LeadingIntRegex();
}
