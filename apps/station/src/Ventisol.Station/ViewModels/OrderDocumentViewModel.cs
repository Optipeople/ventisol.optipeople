using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;
using Ventisol.Station.Documents;

namespace Ventisol.Station.ViewModels;

public enum DocumentState { Empty, Loading, Message, Ready }

// What a station's element is: in progress there now, or the last one done there.
public sealed record DocumentTarget(string StationName, Barcode? Barcode, bool InProgress, DateTimeOffset? At);

// A page of "Vis hele PDF" or "Vis BS-tegning": it has its picture while it is on screen or next to it, and lets it go
// when it is scrolled away, so a long PDF never holds more than a few pages' pictures.
// With a crop only that part of the page is shown, and it is fitted to the screen: a BS drawing, which
// sits in a corner of its sheet, is seen whole and as big as the screen allows. A tap on it makes it
// as wide as the screen (Zoomed), to read its measurements from further off; another tap fits it again.
public sealed partial class PdfPageViewModel(int index, int count, bool isPosition, double width, double height, PdfBox? crop = null) : ObservableObject
{
    public int Index => index;
    public string Caption => $"Side {index + 1} af {count}";
    public bool IsPosition => isPosition;
    public PdfBox? Crop => crop;
    public bool FitsScreen => crop is not null;
    [ObservableProperty, NotifyPropertyChangedFor(nameof(Hint))] public partial bool Zoomed { get; set; }
    // What a tap on the page does, after the caption. Empty for a page that is not fitted.
    public string Hint => crop is null ? "" : Zoomed ? "Tryk på tegningen for at se hele tegningen" : "Tryk på tegningen for at forstørre";
    // The size in points of what is shown, so it takes its place before its picture is there.
    public double Width => crop?.Width ?? width;
    public double Height => crop?.Height ?? height;
    [ObservableProperty] public partial ImageSource? Image { get; set; }
    [ObservableProperty] public partial bool Failed { get; set; }
}

// The element's production document on screen: header, drawing, key facts, cutting list and hardware,
// or why it can't be shown. Show starts a load in the background; a newer Show drops the older one.
public sealed partial class OrderDocumentViewModel : ObservableObject
{
    // Shown after the status line when the document is a copy kept on this PC.
    public const string CopyNote = "Gemt kopi · mappen kan ikke nås lige nu";
    // The same when the copy is an older version than the file the folder last listed for the order.
    public const string OlderCopyNote = "Gemt kopi, ældre udgave · mappen kan ikke nås lige nu";

    readonly OrderDocuments documents;

    // From OptiCloud, it is OptiCloud that can't be reached, not the folder.
    string Note(string note) => documents.Folder is null ? note.Replace("mappen kan ikke nås", "OptiCloud kan ikke nås") : note;

    public OrderDocumentViewModel(OrderDocuments documents)
    {
        this.documents = documents;
        // Every PDF read is kept on this PC too, so a short break in the internet doesn't take it away.
        documents.Cache ??= new OrderDocumentCache(AppPaths.DocumentsCache);
    }

    // Under this, a load shows nothing new, so a pre-fetched document doesn't flash "Henter".
    static readonly TimeSpan LoadingDelay = TimeSpan.FromMilliseconds(250);

    // Pages kept drawn above and below the ones on screen.
    const int PagesAround = 1;

    CancellationTokenSource? _cts;
    OrderDocumentLoad? _load;
    // The PDF held open while its pages are shown, and the one the render loop is working on.
    PdfPages? _pdf, _rendering;
    // The pages on screen, as the view last said.
    int _viewFirst, _viewLast;
    // The file Pages was built from, and its path for the log.
    byte[]? _pagesOf;
    string? _pagesPath;
    // The position is not in the list, so the list's pages are the screen: they can't be left, and the
    // BS drawings go back to them.
    bool _listOnly;

    public DocumentTarget? Target { get; private set; }

    // False for a widget: it never shows the pages, so it doesn't render them either.
    public bool ShowsPages { get; init; } = true;

    // The document on screen is a copy, because the folder can't be reached right now.
    [ObservableProperty] public partial bool FromCopy { get; private set; }
    // ... and an older version than the folder lists now.
    bool _olderCopy;

    [ObservableProperty] public partial DocumentState State { get; private set; } = DocumentState.Empty;
    [ObservableProperty] public partial string StationName { get; private set; } = "";
    [ObservableProperty] public partial string StatusText { get; private set; } = "";
    [ObservableProperty] public partial bool InProgress { get; private set; }
    [ObservableProperty] public partial bool HasElement { get; private set; }

    [ObservableProperty] public partial ElementSheet? Sheet { get; private set; }
    [ObservableProperty] public partial bool HasSheetData { get; private set; }

    [ObservableProperty] public partial string MessageTitle { get; private set; } = "";
    // The same in a few plain words, for the widget: what an operator needs to know, no paths or
    // error texts (those are in MessageDetail, a tap away, and in the log).
    [ObservableProperty] public partial string ShortMessage { get; private set; } = "";
    // The short message is a problem (a warn mark), not just nothing to show yet.
    [ObservableProperty] public partial bool IsProblem { get; private set; }
    [ObservableProperty] public partial string MessageDetail { get; private set; } = "";
    [ObservableProperty] public partial bool CanRetry { get; private set; }
    // A note above the content: the position wasn't in the PDF, or parts of it couldn't be read.
    [ObservableProperty] public partial string? Warning { get; private set; }

    [ObservableProperty] public partial ImageSource? Drawing { get; private set; }
    [ObservableProperty] public partial string DrawingNote { get; private set; } = "";
    [ObservableProperty] public partial bool HasPdf { get; private set; }

    [ObservableProperty] public partial bool ShowingPages { get; private set; }
    [ObservableProperty] public partial bool CanLeavePages { get; private set; }
    public ObservableCollection<PdfPageViewModel> Pages { get; } = [];
    // The page the pages open at: the position's first page.
    [ObservableProperty] public partial int StartPage { get; private set; }
    // What the pages are: the whole list, or the order's BS drawings.
    [ObservableProperty] public partial string PagesTitle { get; private set; } = ListTitle;
    // Where the button that leaves the pages goes.
    [ObservableProperty] public partial string BackText { get; private set; } = BackToElement;

    // The order has BS drawings (of its arched and bevelled positions) that are for this element.
    [ObservableProperty] public partial bool HasBsDrawings { get; private set; }
    // The pages on screen are the BS drawings, not the list.
    [ObservableProperty] public partial bool ShowingBsDrawings { get; private set; }
    // "Vis BS-tegning" is offered: there are drawings, and they are not what is on screen.
    [ObservableProperty] public partial bool CanShowBsDrawings { get; private set; }

    const string ListTitle = "Hele produktionslisten";
    const string BackToElement = "Tilbage til elementet";

    public void Show(DocumentTarget target)
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        Target = target;
        _load = null;
        FromCopy = false;
        _olderCopy = false;
        StationName = target.StationName;
        InProgress = target.InProgress;
        HasElement = target.Barcode is not null;
        UpdateStatus(DateTimeOffset.Now);
        Warning = null;
        Drawing = null;
        DrawingNote = "";
        HasPdf = false;
        HasBsDrawings = false;
        _listOnly = false;
        ClearPages();

        if (target.Barcode is not { } barcode)
        {
            Sheet = null;
            HasSheetData = false;
            State = DocumentState.Empty;
            MessageTitle = $"Intet element på {target.StationName} endnu";
            ShortMessage = "Venter på scanning";
            IsProblem = false;
            MessageDetail = "Scan et element ind, så vises dets produktionsliste her.";
            CanRetry = false;
            return;
        }

        Sheet = ElementSheet.For(barcode);
        HasSheetData = false;
        if (!documents.IsOn)
        {
            Message("Ordredokumenter er slået fra", "Vælg mappen med ordredokumenter under Opsætning for at se produktionslisten her.", retry: false,
                "Ordredokumenter er slået fra");
            return;
        }
        // Blank until the load has taken a moment, then "Henter".
        State = DocumentState.Loading;
        MessageTitle = MessageDetail = ShortMessage = "";
        IsProblem = false;
        CanRetry = false;
        _ = LoadAsync(barcode, _cts.Token);
    }

    // The station's element now: a new element loads, the same one only updates its status line
    // (say, from in progress to scanned out).
    public void Follow(DocumentTarget target)
    {
        if (Target is { } t && t.Barcode?.Raw == target.Barcode?.Raw)
        {
            Target = target;
            InProgress = target.InProgress;
            UpdateStatus(DateTimeOffset.Now);
            return;
        }
        Show(target);
    }

    // The status line as time goes by: "I gang · 12 min", "Scannet ud 10:12".
    public void UpdateStatus(DateTimeOffset now)
    {
        if (Target is not { } t) return;
        StatusText = t switch
        {
            { Barcode: null } => t.StationName,
            { InProgress: true, At: { } since } => $"I gang på {t.StationName} · {Format.Long(now - since)}",
            { InProgress: true } => $"I gang på {t.StationName}",
            { At: { } done } => $"Sidst på {t.StationName} · scannet ud {done.ToLocalTime():HH:mm}",
            _ => $"Sidst på {t.StationName}",
        } + (FromCopy ? " · " + Note(_olderCopy ? OlderCopyNote : CopyNote) : "");
    }

    public void Close()
    {
        _cts?.Cancel();
        _cts = null;
        ClearPages();
        Drawing = null;
    }

    [RelayCommand]
    void Retry()
    {
        if (Target is { } t) Show(t);
    }

    [RelayCommand]
    void ShowPdf() => OpenList();

    // The order's BS drawings, at the page that draws this element's position.
    [RelayCommand]
    void ShowBsDrawings()
    {
        if (_load is not { BsDrawings: { } drawings, BsDrawingsPage: { } start } load) return;
        var position = load.Barcode.Position;
        var named = drawings.PageFor(position) is not null;
        OpenPages(drawings.Pdf, drawings.Path, [.. drawings.Pages.Select(p => (p.Width, p.Height, p.Position == position, p.Content))], start,
            canLeave: true, drawings: true,
            named ? $"BS-tegning · position {position}" : "BS-tegninger");
    }

    [RelayCommand]
    void HidePdf()
    {
        if (!CanLeavePages) return;
        if (ShowingBsDrawings && _listOnly) OpenList();
        else ClosePages();
    }

    // Fire and forget from Show, so nothing may escape: whatever goes wrong on the way is logged and
    // shown with "Prøv igen", never left as "Henter produktionsliste" for good.
    async Task LoadAsync(Barcode barcode, CancellationToken ct)
    {
        try { await LoadDocumentAsync(barcode, ct); }
        catch (Exception ex)
        {
            // A newer Show or a Close took over; this load has nothing to say any more.
            if (ct.IsCancellationRequested) return;
            Log.Write($"Order document for {barcode.Raw} failed: {ex}");
            try
            {
                ClosePages();
                Message("Produktionslisten kunne ikke hentes", ex.Message, retry: true, "Produktionslisten kunne ikke hentes");
            }
            catch (Exception again) { Log.Write($"Showing the failure for {barcode.Raw} failed: {again.Message}"); }
        }
    }

    async Task LoadDocumentAsync(Barcode barcode, CancellationToken ct)
    {
        var loading = Task.Delay(LoadingDelay, ct).ContinueWith(_ => { }, TaskScheduler.Default);
        var task = documents.LoadAsync(barcode, ct);
        if (await Task.WhenAny(task, loading) != task && !ct.IsCancellationRequested)
        {
            MessageTitle = $"Henter produktionsliste for ordre {barcode.Order}";
            ShortMessage = "Henter produktionsliste";
        }

        var load = await task;
        if (ct.IsCancellationRequested) return;
        _load = load;

        switch (load.Status)
        {
            case OrderDocumentLoadStatus.Off:
                Message("Ordredokumenter er slået fra", "Vælg mappen med ordredokumenter under Opsætning for at se produktionslisten her.", retry: false,
                    "Ordredokumenter er slået fra");
                return;
            case OrderDocumentLoadStatus.FolderUnavailable:
                if (documents.Folder is null)
                    Message("Ordredokumenterne kan ikke hentes fra OptiCloud", $"{load.Error ?? "OptiCloud svarer ikke"}.", retry: true,
                        "OptiCloud kan ikke nås");
                else
                    Message("Mappen med ordredokumenter kan ikke læses", $"{load.Error ?? "Mappen svarer ikke"}. {documents.Folder}", retry: true,
                        "Dokumentmappen kan ikke nås");
                return;
            case OrderDocumentLoadStatus.NotFound:
                Message($"Ingen produktionsliste for ordre {barcode.Order}", $"Der ligger ingen {barcode.Order}_*.pdf (eller fx BE_{barcode.Order}_*.pdf) i {documents.SourceName}.", retry: true,
                    "Ingen produktionsliste fundet");
                return;
            case OrderDocumentLoadStatus.Unreadable:
                Message($"Produktionslisten for ordre {barcode.Order} kan ikke åbnes", load.Error ?? "Filen kan ikke læses", retry: true,
                    "Produktionslisten kan ikke åbnes");
                return;
        }

        var doc = load.Document!;
        if (load.FromCopy)
        {
            _olderCopy = load.OlderVersion;
            FromCopy = true;
            UpdateStatus(DateTimeOffset.Now);
            Log.Write($"Order document {load.Path}: shown from a{(load.OlderVersion ? "n older" : "")} copy, the folder can't be reached");
        }
        Sheet = ElementSheet.For(barcode, doc, load.Position);
        HasPdf = load.Pdf is not null;
        HasBsDrawings = ShowsPages && load.BsDrawingsPage is not null;
        CanShowBsDrawings = HasBsDrawings;
        HasSheetData = load.Position is not null;
        State = DocumentState.Ready;
        if (load.Position is null)
        {
            Warning = ShowsPages
                ? $"Position {Sheet.Position} står ikke i produktionslisten. Hele PDF'en vises."
                : $"Position {Sheet.Position} står ikke i produktionslisten. Tryk for at se hele PDF'en.";
            // A widget has no pages to show, so its drawing area says where they are.
            if (!ShowsPages) DrawingNote = "Tryk for at se hele PDF'en";
            _listOnly = true;
            OpenList();
            return;
        }
        if (doc.Problems.Count > 0)
        {
            Warning = "Dele af produktionslisten kunne ikke læses. Tjek med \"Vis hele PDF\".";
            Log.Write($"Order document {load.Path}: {string.Join("; ", doc.Problems)}");
        }
        await ShowDrawingAsync(load, load.Position, ct);
    }

    async Task ShowDrawingAsync(OrderDocumentLoad load, OrderPosition position, CancellationToken ct)
    {
        if (position.Drawing is null || load.Pdf is null)
        {
            DrawingNote = "Ingen tegning fundet";
            return;
        }
        DrawingNote = "Tegner";
        try
        {
            var (ground, ink) = DrawingColours();
            var image = await PdfRender.DrawingAsync(load, position, ground, ink);
            if (ct.IsCancellationRequested) return;
            Drawing = image;
            DrawingNote = "";
        }
        catch (Exception ex)
        {
            if (ct.IsCancellationRequested) return;
            Log.Write($"Drawing for {load.Barcode.Raw} failed: {ex.Message}");
            DrawingNote = "Tegningen kan ikke vises";
        }
    }

    // The whole list, from the position's page.
    void OpenList()
    {
        if (_load is not { Pdf: { } pdf, Document: { } doc } load) return;
        // Every page in the samples has the same size; the drawing box knows it.
        var box = doc.Positions.Select(p => p.Drawing).FirstOrDefault(d => d is not null);
        var (w, h) = box is null ? (839.0, 592.0) : (box.PageWidth, box.PageHeight);
        var position = load.Position;
        var pages = new (double, double, bool, PdfBox?)[doc.PageCount];
        for (var i = 0; i < pages.Length; i++)
            pages[i] = (w, h, position is not null && i >= position.PageIndex && i < position.PageIndex + position.PageCount, null);
        OpenPages(pdf, load.Path, pages, position?.PageIndex ?? 0, canLeave: !_listOnly, drawings: false, ListTitle);
    }

    // Shows a PDF's pages, from page start. One file's pages at a time: another file takes over.
    void OpenPages(byte[] pdf, string? path, IReadOnlyList<(double Width, double Height, bool IsPosition, PdfBox? Crop)> pages, int start,
        bool canLeave, bool drawings, string title)
    {
        if (!ShowsPages || _cts is null) return;
        if (!ReferenceEquals(_pagesOf, pdf))
        {
            ClearPages();
            for (var i = 0; i < pages.Count; i++)
                Pages.Add(new PdfPageViewModel(i, pages.Count, pages[i].IsPosition, pages[i].Width, pages[i].Height, pages[i].Crop));
            _pagesOf = pdf;
            _pagesPath = path;
        }
        CanLeavePages = canLeave;
        PagesTitle = title;
        // From the drawings of an element with nothing but the list's pages, the way back is to those.
        BackText = drawings && _listOnly ? "Tilbage til produktionslisten" : BackToElement;
        ShowingBsDrawings = drawings;
        CanShowBsDrawings = HasBsDrawings && !drawings;
        StartPage = Math.Clamp(start, 0, Math.Max(0, Pages.Count - 1));
        _pdf ??= new PdfPages(pdf);
        ShowingPages = true;
        // The start page is drawn at once; the view then says which pages are on screen as it scrolls.
        PagesInView(StartPage, StartPage);
    }

    // Closes the pages and forgets them, for another file or another element.
    void ClearPages()
    {
        ClosePages();
        Pages.Clear();
        _pagesOf = null;
        _pagesPath = null;
    }

    // Hides the pages and lets go of their pictures and of the open PDF.
    void ClosePages()
    {
        ShowingPages = false;
        ShowingBsDrawings = false;
        CanShowBsDrawings = HasBsDrawings;
        _pdf?.Dispose();
        _pdf = null;
        foreach (var page in Pages)
        {
            page.Image = null;
            page.Failed = false;
        }
    }

    // From the view: pages first to last (0-based) are on screen now. They and their neighbours get
    // their pictures; every other page gives its picture up.
    public void PagesInView(int first, int last)
    {
        if (!ShowingPages || Pages.Count == 0) return;
        _viewFirst = Math.Clamp(first, 0, Pages.Count - 1);
        _viewLast = Math.Clamp(last, _viewFirst, Pages.Count - 1);
        foreach (var page in Pages)
            if (!IsNear(page.Index)) page.Image = null;
        _ = RenderPagesAsync();
    }

    bool IsNear(int index) => index >= _viewFirst - PagesAround && index <= _viewLast + PagesAround;

    // The next page to draw: one on screen before a neighbour, top first.
    PdfPageViewModel? NextPage() => Pages
        .Where(p => IsNear(p.Index) && p.Image is null && !p.Failed)
        .OrderBy(p => p.Index >= _viewFirst && p.Index <= _viewLast ? 0 : 1)
        .ThenBy(p => p.Index)
        .FirstOrDefault();

    // Draws the pages wanted right now, one at a time, until none is missing. One loop per open PDF;
    // it ends when the pages close or another document takes over.
    async Task RenderPagesAsync()
    {
        if (_pdf is not { } pdf || _rendering == pdf) return;
        _rendering = pdf;
        try
        {
            while (_pdf == pdf && NextPage() is { } page)
            {
                try
                {
                    var image = await pdf.PageAsync(page.Index, page.Crop);
                    if (_pdf != pdf) return;
                    // Scrolled away while it was drawn: PdfPages keeps it for a while, the page doesn't.
                    if (IsNear(page.Index)) page.Image = image;
                }
                catch (Exception ex)
                {
                    if (_pdf != pdf) return;
                    Log.Write($"Page {page.Index + 1} of {_pagesPath} failed: {ex.Message}");
                    page.Failed = true;
                }
            }
        }
        catch (Exception ex) { Log.Write($"Drawing the pages failed: {ex.Message}"); }
        finally
        {
            if (_rendering == pdf) _rendering = null;
        }
    }

    void Message(string title, string detail, bool retry, string shortMessage)
    {
        ShortMessage = shortMessage;
        IsProblem = true;
        State = DocumentState.Message;
        MessageTitle = title;
        MessageDetail = detail;
        CanRetry = retry;
    }

    // The drawing in the screen's ink on its panel colour. On the UI thread.
    public static (Color Ground, Color Ink) DrawingColours() => (Colour("Panel"), Colour("Ink"));

    static Color Colour(string key) =>
        Application.Current?.TryFindResource(key) is SolidColorBrush b ? b.Color : key == "Ink" ? Colors.White : Colors.Black;
}
