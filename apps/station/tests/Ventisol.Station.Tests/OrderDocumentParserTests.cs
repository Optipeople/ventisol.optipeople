using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Tests;

// The real order PDFs are customer data and stay out of the repo. When the untracked folder
// orderdocs/ is at the repo root (as on the developer's PC), the sample tests read it; elsewhere
// they are skipped. The synthetic tests always run.
public static class OrderDocSamples
{
    public static string? Folder { get; } = Find();

    static string? Find()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "orderdocs");
            if (Directory.Exists(candidate) && Directory.EnumerateFiles(candidate, "*.pdf").Any()) return candidate;
        }
        return null;
    }

    public static string File(int order) => Directory.GetFiles(Folder!, $"{order}_*.pdf").Single();

    public static OrderDocument Parse(int order) => OrderDocumentParser.Parse(File(order));
}

public sealed class SamplesFactAttribute : FactAttribute
{
    public SamplesFactAttribute()
    {
        if (OrderDocSamples.Folder is null) Skip = "No orderdocs folder with sample PDFs";
    }
}

public class OrderDocumentParserTests
{
    // ----- Against the 26 samples, when present

    [SamplesFact]
    public void Every_sample_parses_whole()
    {
        var files = Directory.GetFiles(OrderDocSamples.Folder!, "*.pdf");
        Assert.NotEmpty(files);
        foreach (var file in files)
        {
            var doc = OrderDocumentParser.Parse(file);
            var name = Path.GetFileName(file);
            Assert.True(doc.Problems.Count == 0, $"{name}: {string.Join("; ", doc.Problems)}");
            Assert.True(OrderDocumentLocator.TryParseFileName(name, out var order, out _));
            Assert.Equal(order, doc.Header.OrderNumber);
            Assert.NotNull(doc.Header.Date);
            Assert.NotNull(doc.Header.DeliveryWeek);
            Assert.NotEmpty(doc.Header.Customer);
            Assert.NotEmpty(doc.Positions);

            var next = 0;
            foreach (var p in doc.Positions)
            {
                Assert.True(p.Number > 0, name);
                Assert.Equal(next, p.PageIndex);
                next = p.PageIndex + p.PageCount;
                Assert.NotNull(p.System);
                Assert.NotNull(p.Quantity);
                Assert.NotEmpty(p.Fields);
                Assert.All(p.Fields, f => Assert.Matches(@"^\d+$", f.Number));
                Assert.NotNull(p.SizeWithoutCoupling);
                Assert.NotNull(p.Drawing);
                Assert.InRange(p.Drawing.Left, 500, 620);
                Assert.InRange(p.Drawing.Width, 30, 200);
                Assert.InRange(p.Drawing.Height, 40, 200);
                Assert.All(p.Cutting, c => { Assert.NotEmpty(c.Profile); Assert.NotNull(c.Quantity); Assert.NotNull(c.Length); });
                Assert.All(p.Hardware.Concat(p.Accessories), h => { Assert.NotEmpty(h.Description); Assert.NotNull(h.Quantity); });
            }
            Assert.Equal(doc.PageCount, next);
        }
    }

    [SamplesFact]
    public void A_window_with_its_cutting_list_hardware_and_accessories_on_the_next_page()
    {
        var doc = OrderDocSamples.Parse(58721);

        Assert.Equal(4, doc.PageCount);
        Assert.Equal(46, doc.Header.DeliveryWeek);
        Assert.Equal(new DateOnly(2026, 10, 22), doc.Header.Date);
        Assert.Equal(3, doc.Header.Customer.Count);
        Assert.Null(doc.Header.GlassPallet);

        var p = Assert.Single(doc.Positions, p => p.Number == 1);
        Assert.Equal((0, 2), (p.PageIndex, p.PageCount));
        Assert.Equal("SOFTLINE", p.System);
        Assert.Equal(("Hvid", "Hvid", "Grå"), (p.FrameColour, p.SashColour, p.SealColour));
        Assert.Equal(1, p.Quantity);
        Assert.Equal("d=6,5 ve/hø", p.FrameHoles);
        Assert.Equal("1:50", p.Scale);
        Assert.Equal(84.5m, p.WeightKg);
        Assert.Equal(new ElementSize(1485.0m, 1380.0m, "1485,0 * 1380,0"), p.SizeWithoutCoupling);

        var f = Assert.Single(p.Fields);
        Assert.Equal("1", f.Number);
        Assert.Equal("Drej Kip V.I.", f.Opening);
        Assert.Equal("1415,0 * 1310,0", f.FrameSize);
        Assert.Equal(["Energi ECLAZ 0,6 4-14-4-14-4 varm kant", "indv. 4 mm Energi ECLAZ", "midt. 4 mm Energi ECLAZ", "udv. 4 mm glas"], f.GlassType);
        Assert.Equal([new GlassPane(1, "1283 * 1178", "107.208_G")], f.Panes);

        Assert.Equal(8, p.Cutting.Count);
        Assert.Equal(new CutRow("Karm", "101.282_G", null, 1, "1491,0", "Un", "113.002", "1390", null, null), p.Cutting[0]);
        Assert.Equal(new CutRow("Ramme", "103.232 Z_G", null, 1, "1316,0", "Hø", "113.292", "1150", "1", null), p.Cutting[7]);

        Assert.Equal(11, p.Hardware.Count);
        Assert.Equal(new HardwareRow("Beskrivelse", "Getr. 15 Titan AF Gr. 120 TS 2RS 700 TGMK4160", null, "1", null, null, null), p.Hardware[9]);
        Assert.Equal(["Drænkappe fra Veka", "Dreje-kip greb", "Skrue 5x45 mm"], p.Accessories.Select(a => a.Description));

        var two = doc.PositionFor(2)!;
        Assert.Equal((2, 2), (two.PageIndex, two.PageCount));
        Assert.Contains(two.Accessories, a => a.Description == "Vandnæse" && a.Quantity == "1" && a.Size == "800,0");
    }

    [SamplesFact]
    public void A_double_door_with_two_panes_per_field_and_glazing_bars()
    {
        var p = OrderDocSamples.Parse(58802).PositionFor(18)!;

        Assert.Equal(2, p.Fields.Count);
        Assert.Equal("Industridør stående", p.Fields[0].Opening);
        Assert.Equal("Industridør H.U. falle m/galv.trin", p.Fields[1].Opening);
        Assert.All(p.Fields, f =>
        {
            Assert.Equal([new GlassPane(1, "675 * 952", "107.214_G"), new GlassPane(1, "675 * 952", "107.214_G")], f.Panes);
            Assert.Equal(["112.253"], f.Seals);
            Assert.Contains("Fyldning 23 mm, Hvid", f.GlassType);
        });

        Assert.Contains(new CutRow("Karm", "galv.20x50", null, 1, "1704,0", "Un", null, null, null, null), p.Cutting);
        Assert.Contains(p.Cutting, c => c.Steel == "**113.368.2" && c.Field == "2");
        Assert.Equal(2, p.Cutting.Count(c => c.Section == "Sprosse" && c.Width == "85,0" && c.Side == "Van." && c.Clearance == "924,0"));
        Assert.Equal(new HardwareRow("Beskrivelse", "Haps hængsel P100 Hvid", "Hvid", "6", null, null, null), p.Hardware[0]);
        Assert.Equal(2, p.PageCount);
    }

    [SamplesFact]
    public void Three_fields_in_one_frame_with_a_mullion()
    {
        var p = OrderDocSamples.Parse(58813).PositionFor(1)!;

        Assert.Equal(["Fast karm", "Drej Kip H.I.", "Fast karm"], p.Fields.Select(f => f.Opening));
        Assert.Null(p.Fields[0].FrameSize);
        Assert.Equal("828,7 * 1390,0", p.Fields[1].FrameSize);
        Assert.Contains(p.Cutting, c => c.Section == "Karm" && c.Side == "Lp" && c.Quantity == 2);
        Assert.Equal(2610.0m, p.SizeWithoutCoupling!.Width);
    }

    [SamplesFact]
    public void Overprinted_text_and_tables_that_go_on_over_a_page()
    {
        var sw = OrderDocSamples.Parse(58826).PositionFor(1)!;
        Assert.Contains(sw.Hardware, h => h.Description == "Anverfer m/pladeøsken IPA 2139610212" && h.Colour == "Eloxeret");
        Assert.Equal(6, sw.Cutting.Count(c => c.Section == "Sprosse" && c.Profile == "109.590.2 2s sw" && c.Width == "25,0"));

        var add = OrderDocSamples.Parse(58800).PositionFor(1)!;
        var profiles = add.Accessories.Where(a => a.Group == "Tilsætningsprofil").ToList();
        Assert.Equal(4, profiles.Count);
        Assert.Equal(new HardwareRow("Tilsætningsprofil", "8 mm notl. vand", "Hvid", "1", "1244,0", "Monteret", "nederst"), profiles[0]);
    }

    [SamplesFact]
    public void Glazing_bars_notes_and_gaps_in_the_position_numbers()
    {
        var bars = OrderDocSamples.Parse(58815).PositionFor(1)!;
        Assert.Equal(new FieldBarRow("1", "26 mm. ilagt", "Hvid", "Lod.", "303,3"), bars.FieldBars[0]);

        var doc = OrderDocSamples.Parse(58829);
        Assert.Equal([3, 5], doc.Positions.Select(p => p.Number));
        Assert.Equal(["Tilbudt med 55 mm påklæbet sprosse", "lodret udv. & indv."], doc.PositionFor(3)!.Notes);
        Assert.Null(doc.PositionFor(4));

        var notes = OrderDocSamples.Parse(58763).PositionFor(1)!;
        Assert.Contains("Som type G m/alm FD greb og med åbningsbegrænser", notes.Notes);
        Assert.All(notes.Fields, f => Assert.Matches(@"^\d+$", f.Number));
    }

    [SamplesFact]
    public void A_barcode_finds_its_position_whatever_its_sub_position()
    {
        var doc = OrderDocSamples.Parse(58721);
        Assert.True(Barcode.TryParse("058721010103", out var one));
        Assert.True(Barcode.TryParse("058721020201", out var twoSub));
        Assert.Equal(1, doc.PositionFor(one)!.Number);
        Assert.Equal(2, doc.PositionFor(twoSub)!.Number);
        Assert.True(Barcode.TryParse("058721090101", out var none));
        Assert.Null(doc.PositionFor(none));
    }

    // ----- Synthetic

    [Fact]
    public void Garbage_gives_a_problem_not_an_exception()
    {
        var doc = OrderDocumentParser.Parse("not a pdf at all"u8.ToArray(), "x.pdf");
        Assert.Empty(doc.Positions);
        Assert.NotEmpty(doc.Problems);
        Assert.Null(doc.Header.OrderNumber);

        Assert.NotEmpty(OrderDocumentParser.Parse([]).Problems);
        Assert.NotEmpty(OrderDocumentParser.Parse(Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.pdf")).Problems);
    }

    [Fact]
    public void A_pdf_of_another_kind_gives_an_empty_model()
    {
        var b = new PdfDocumentBuilder();
        var font = b.AddStandard14Font(Standard14Font.Helvetica);
        b.AddPage(595, 842).AddText("Just a letter", 12, new PdfPoint(50, 700), font);

        var doc = OrderDocumentParser.Parse(b.Build());

        Assert.Equal(1, doc.PageCount);
        Assert.Empty(doc.Positions);
        Assert.Contains("No positions found", doc.Problems);
    }

    [Fact]
    public void A_synthetic_production_list_is_read_by_position()
    {
        var doc = OrderDocumentParser.Parse(SyntheticProductionList());

        Assert.Equal(58556, doc.Header.OrderNumber);
        Assert.Equal(43, doc.Header.DeliveryWeek);
        Assert.Equal(new DateOnly(2026, 10, 1), doc.Header.Date);
        Assert.Equal(["Test Customer", "Street 1", "1234 Town"], doc.Header.Customer);
        Assert.Equal(["Site Address", "Road 2"], doc.Header.DeliveryAddress);

        var p = Assert.Single(doc.Positions);
        Assert.Equal((5, 0, 2), (p.Number, p.PageIndex, p.PageCount));
        Assert.Equal("SOFTLINE", p.System);
        Assert.Equal(2, p.Quantity);
        Assert.Equal(["Karm og ramme pakkes saerskilt"], p.Notes);
        Assert.Equal("1:50", p.Scale);
        Assert.Equal(12.5m, p.WeightKg);
        Assert.Equal(new ElementSize(1183.0m, 1539.0m, "1183,0 * 1539,0"), p.SizeWithoutCoupling);

        var f = Assert.Single(p.Fields);
        Assert.Equal(("1", "Drej Kip V.I.", "1100,0 * 1450,0"), (f.Number, f.Opening, f.FrameSize));
        Assert.Equal(["Energi 4-16-4", "indv. 4 mm glas"], f.GlassType);
        Assert.Equal([new GlassPane(2, "990 * 1330", "107.214_G")], f.Panes);

        Assert.Equal([
            new CutRow("Karm", "101.282_G", null, 2, "1189,0", "Un", "113.002", "1090", null, null),
            new CutRow("Ramme", "103.232 Z_G", null, 2, "1106,0", "Ov", "113.292", "950", "1", null),
        ], p.Cutting);
        Assert.Equal([new HardwareRow("Beskrivelse", "Saks AF Gr. 2 1RS", "Hvid", "2", null, null, null)], p.Hardware);
        Assert.Equal([new HardwareRow("Tilbehoer", "Skrue 5x45 mm", null, "4", null, null, null)], p.Accessories);

        Assert.NotNull(p.Drawing);
        Assert.True(p.Drawing.Left <= 578 && p.Drawing.Right >= 658, $"{p.Drawing}");
        Assert.True(p.Drawing.Bottom <= 200 && p.Drawing.Top >= 279, $"{p.Drawing}");
        Assert.True(p.Drawing.Right < 700 && p.Drawing.Bottom > 150, $"{p.Drawing}");
        Assert.Equal((839, 592), (p.Drawing.PageWidth, p.Drawing.PageHeight));
    }

    // Two pages laid out like the real thing, in ASCII (the standard fonts have no æøå here):
    // a position on the first, its accessories going on on the second. "Tilbehoer" stands in as an
    // unknown heading, so its rows land in Accessories under that group.
    static byte[] SyntheticProductionList()
    {
        var b = new PdfDocumentBuilder();
        var regular = b.AddStandard14Font(Standard14Font.Helvetica);
        var bold = b.AddStandard14Font(Standard14Font.HelveticaBold);

        PdfPageBuilder Page(int side)
        {
            var page = b.AddPage(839, 592);
            void T(string s, double x, double y, bool isBold = false) => page.AddText(s, 9.7, new PdfPoint(x, y), isBold ? bold : regular);
            page.AddText("Produktionsliste", 15.6, new PdfPoint(42.5, 534.3), bold);
            T("Kunde:", 183.7, 540.1); T("Test Customer", 226.4, 540.1);
            T("Lev. adr.:", 395.4, 540.1); T("Site Address", 452.2, 540.1);
            T("Side:", 650.3, 540.1); T(side.ToString(), 706.3, 540.1);
            T("Street 1", 226.4, 528.9); T("Road 2", 452.2, 528.9);
            T("Ordrer nr.:", 42.5, 520.6); T("58556", 91, 520.6, true);
            T("1234 Town", 226.4, 517.7);
            T("Lev. uge:", 42.5, 507.3); T("43", 91, 507.3);
            T("Dato:", 42.5, 493.8); T("01-10-2026", 91, 493.8);
            T("Sagsbeh.:", 42.5, 480.5); T("A. Person", 91, 480.5); T("Pakke info.:", 395.4, 480.5);
            T(new string('_', 120), 39.5, 465.7);
            return page;
        }

        var p1 = Page(1);
        void A(string s, double x, double y, bool isBold = false) => p1.AddText(s, 9.7, new PdfPoint(x, y), isBold ? bold : regular);
        A("System", 34.2, 443.8); A("SOFTLINE", 99.2, 443.8, true); A("Felt oplysninger", 198.7, 443.8, true);
        A("Felt", 198.7, 429.7, true); A("Abningsfunktion", 222.6, 429.7, true); A("Rammemaal", 364.6, 429.7, true);
        A("Glastype", 439.3, 429.7, true); A("Stk", 593.4, 429.7, true); A("Glasmaal", 627.8, 429.7, true);
        A("Glasliste", 701.2, 429.7, true); A("Taetning", 756.4, 429.7, true);
        A("Position:", 34.2, 423.0); A("5", 99.2, 423.0, true);
        A("1", 201.4, 417.0); A("Drej Kip V.I.", 222.6, 417.0); A("1100,0 * 1450,0", 364.6, 417.0);
        A("Energi 4-16-4", 439.3, 417.0); A("2", 593.4, 417.0); A("990 * 1330", 627.8, 417.0); A("107.214_G", 696.5, 417.0);
        A("Farve karm:", 34.2, 408.8); A("Hvid", 99.2, 408.8, true);
        A("indv. 4 mm glas", 439.3, 405.5);
        A("Antal:", 34.2, 364.9); A("2", 99.2, 364.9, true);
        A("Karm og ramme pakkes saerskilt", 34.2, 330.0, true);
        A("1:50", 582.4, 321.7, true); A("Ca. 12,5 kg pr.element", 636.8, 321.7);
        A(new string('-', 120), 28.2, 320.3);
        A("Afkortning", 32, 309.9, true); A("Stk.:", 136.7, 309.9, true); A("Stal:", 317.6, 309.9, true);
        A("Felt", 410.3, 309.9, true); A("nr.:", 430.2, 309.9, true); A("Lysm.", 449.9, 309.9, true);
        A("Mal u/kobling:", 593.4, 305.9, true); A("1183,0 * 1539,0", 672.2, 305.9, true);
        A("Karm", 32, 296.3, true);
        A("101.282_G", 32, 284.8); A("2", 145.7, 284.8); A("1189,0", 188.3, 284.8); A("Un", 230.2, 284.8); A("113.002", 316.2, 284.8); A("1090", 372.2, 284.8);
        A("Ramme", 32, 240.0, true);
        A("103.232 Z_G", 32, 228.4); A("2", 145.7, 228.4); A("1106,0", 188.3, 228.4); A("Ov", 230.9, 228.4); A("113.292", 315.5, 228.4); A("950", 372.2, 228.4); A("1", 426.8, 228.4);
        A(new string('-', 120), 28.2, 186.6);
        A("Beskrivelse", 32, 174.3, true); A("Farve", 187.6, 174.3, true); A("Antal", 257.8, 174.3, true); A("Placering", 427.6, 174.3, true);
        A("Saks AF Gr. 2 1RS", 32, 162.8); A("Hvid", 187.6, 162.8); A("2", 257.8, 162.8);
        A("Tilbehoer", 32, 38.8, true);
        // The drawing: a frame and a sash, and a size beside it.
        p1.DrawRectangle(new PdfPoint(578, 200.8), 80, 78, 0.12);
        p1.DrawRectangle(new PdfPoint(584.6, 207.3), 67, 65, 0.12);
        A("1183,0", 605, 186.9);

        var p2 = Page(2);
        p2.AddText(".", 9.7, new PdfPoint(284, 455.8), regular);
        p2.AddText("Skrue 5x45 mm", 9.7, new PdfPoint(32, 433.3), regular);
        p2.AddText("4", 9.7, new PdfPoint(245, 433.3), regular);
        return b.Build();
    }
}
