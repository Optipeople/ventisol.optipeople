using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace Ventisol.Station.Core.Documents;

// A page of a BS drawings PDF: the position it draws (null when the page doesn't say), its size in
// points, and the part of it that is drawn on (the drawing sits in a corner of an otherwise empty
// sheet), so the screen can show that part alone. Content is null when it couldn't be told.
public readonly record struct BsDrawingPage(int? Position, double Width, double Height, PdfBox? Content = null);

// The order's BS drawings ("58931_20261127BS tegninger.pdf"): the production drawings of its arched and
// bevelled positions, a page per position, with the measurements and angles the list's small drawing
// leaves out. Each page is headed "Produktions tegning" and "Position : 2"; there is no other position
// data. Pdf is the file's bytes, Path the file they came from (the share's, or the copy on this PC).
public sealed record BsDrawings(byte[] Pdf, string Path, string FileKey, IReadOnlyList<BsDrawingPage> Pages, bool FromCopy)
{
    // The first page (0-based) that draws the position, or null when no page names it.
    public int? PageFor(int position)
    {
        for (var i = 0; i < Pages.Count; i++)
            if (Pages[i].Position == position) return i;
        return null;
    }

    // Whether any page says which position it draws.
    public bool NamesPositions => Pages.Any(p => p.Position is not null);
}

public static partial class OrderDocumentParser
{
    // The pages of a BS drawings PDF, each with the position printed on it ("Position : 2"). A page
    // that can't be read, or doesn't name a position, has none; a file that is no PDF gives no pages.
    // It never throws.
    public static IReadOnlyList<BsDrawingPage> DrawingPages(byte[] pdf)
    {
        var pages = new List<BsDrawingPage>();
        try
        {
            using var stream = new MemoryStream(pdf, writable: false);
            using var doc = PdfDocument.Open(stream);
            for (var i = 0; i < doc.NumberOfPages; i++)
            {
                try
                {
                    var page = doc.GetPage(i + 1);
                    var text = PageText.Read(page, i);
                    int? position = null;
                    foreach (var line in text.Lines)
                    {
                        var m = DrawingPositionRegex().Match(string.Join(" ", line.Words.Select(w => w.Text)));
                        if (!m.Success || !int.TryParse(m.Groups[1].Value, out var n)) continue;
                        position = n;
                        break;
                    }
                    PdfBox? content = null;
                    try { content = ContentBox(page); }
                    catch (Exception) { }
                    pages.Add(new BsDrawingPage(position, page.Width, page.Height, content));
                }
                catch (Exception)
                {
                    // The page still has its place, so the page numbers match the file's.
                    pages.Add(new BsDrawingPage(null, 839, 592));
                }
            }
        }
        catch (Exception)
        {
            // Not a PDF that can be read: what was read so far stands.
        }
        return pages;
    }

    // Room left around what is drawn, in points.
    const double ContentPadding = 14;

    // The box around every letter and line on the page, padded. Null for an empty page.
    static PdfBox? ContentBox(Page page)
    {
        double left = double.MaxValue, bottom = double.MaxValue, right = double.MinValue, top = double.MinValue;
        void Add(double x0, double y0, double x1, double y1)
        {
            left = Math.Min(left, Math.Min(x0, x1));
            right = Math.Max(right, Math.Max(x0, x1));
            bottom = Math.Min(bottom, Math.Min(y0, y1));
            top = Math.Max(top, Math.Max(y0, y1));
        }

        foreach (var letter in page.Letters)
        {
            if (string.IsNullOrWhiteSpace(letter.Value)) continue;
            var r = letter.BoundingBox;
            Add(r.Left, r.Bottom, r.Right, r.Top);
        }
        foreach (var path in page.Paths)
            if ((path.IsStroked || path.IsFilled) && path.GetBoundingRectangle() is { } r)
                Add(r.Left, r.Bottom, r.Right, r.Top);
        if (right <= left || top <= bottom) return null;

        left = Math.Max(0, left - ContentPadding);
        bottom = Math.Max(0, bottom - ContentPadding);
        right = Math.Min(page.Width, right + ContentPadding);
        top = Math.Min(page.Height, top + ContentPadding);
        return right - left < 20 || top - bottom < 20 ? null : new PdfBox(left, bottom, right, top, page.Width, page.Height);
    }

    [GeneratedRegex(@"\bPosition\s*:\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DrawingPositionRegex();
}
