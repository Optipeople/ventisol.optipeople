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

// A page of "Vis hele PDF": filled in when it has been rendered.
public sealed partial class PdfPageViewModel(int index, int count, bool isPosition, double width, double height) : ObservableObject
{
    public int Index => index;
    public string Caption => $"Side {index + 1} af {count}";
    public bool IsPosition => isPosition;
    // The page's size in points, so it takes its place before its picture is there.
    public double Width => width;
    public double Height => height;
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
    public const string OlderCopyNote = "Gemt kopi – ældre udgave · mappen kan ikke nås lige nu";

    readonly OrderDocuments documents;

    public OrderDocumentViewModel(OrderDocuments documents)
    {
        this.documents = documents;
        // Every PDF read is kept on this PC too, so a short break in the internet doesn't take it away.
        documents.Cache ??= new OrderDocumentCache(AppPaths.DocumentsCache);
    }

    // Under this, a load shows nothing new, so a pre-fetched document doesn't flash "Henter".
    static readonly TimeSpan LoadingDelay = TimeSpan.FromMilliseconds(250);

    CancellationTokenSource? _cts;
    OrderDocumentLoad? _load;

    public DocumentTarget? Target { get; private set; }

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
    // The page "Vis hele PDF" starts at: the position's first page.
    [ObservableProperty] public partial int StartPage { get; private set; }

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
        ClosePages();
        Pages.Clear();

        if (target.Barcode is not { } barcode)
        {
            Sheet = null;
            HasSheetData = false;
            State = DocumentState.Empty;
            MessageTitle = $"Intet element på {target.StationName} endnu";
            MessageDetail = "Scan et element ind, så vises dets produktionsliste her.";
            CanRetry = false;
            return;
        }

        Sheet = ElementSheet.For(barcode);
        HasSheetData = false;
        if (!documents.IsOn)
        {
            Message("Ordredokumenter er slået fra", "Vælg mappen med ordredokumenter under Opsætning for at se produktionslisten her.", retry: false);
            return;
        }
        // Blank until the load has taken a moment, then "Henter".
        State = DocumentState.Loading;
        MessageTitle = MessageDetail = "";
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
        } + (FromCopy ? " · " + (_olderCopy ? OlderCopyNote : CopyNote) : "");
    }

    public void Close()
    {
        _cts?.Cancel();
        _cts = null;
        ClosePages();
        Pages.Clear();
        Drawing = null;
    }

    [RelayCommand]
    void Retry()
    {
        if (Target is { } t) Show(t);
    }

    [RelayCommand]
    void ShowPdf() => OpenPages(_load?.Position?.PageIndex ?? 0);

    [RelayCommand]
    void HidePdf()
    {
        if (CanLeavePages) ClosePages();
    }

    async Task LoadAsync(Barcode barcode, CancellationToken ct)
    {
        var loading = Task.Delay(LoadingDelay, ct).ContinueWith(_ => { }, TaskScheduler.Default);
        var task = documents.LoadAsync(barcode, ct);
        if (await Task.WhenAny(task, loading) != task && !ct.IsCancellationRequested)
            MessageTitle = $"Henter produktionsliste for ordre {barcode.Order}";

        OrderDocumentLoad load;
        try { load = await task; }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            if (ct.IsCancellationRequested) return;
            Log.Write($"Order document for {barcode.Raw} failed: {ex}");
            Message("Produktionslisten kunne ikke hentes", ex.Message, retry: true);
            return;
        }
        if (ct.IsCancellationRequested) return;
        _load = load;

        switch (load.Status)
        {
            case OrderDocumentLoadStatus.Off:
                Message("Ordredokumenter er slået fra", "Vælg mappen med ordredokumenter under Opsætning for at se produktionslisten her.", retry: false);
                return;
            case OrderDocumentLoadStatus.FolderUnavailable:
                Message("Mappen med ordredokumenter kan ikke læses", $"{load.Error ?? "Mappen svarer ikke"}. {documents.Folder}", retry: true);
                return;
            case OrderDocumentLoadStatus.NotFound:
                Message($"Ingen produktionsliste for ordre {barcode.Order}", $"Der ligger ingen {barcode.Order}_*.pdf (eller fx BE_{barcode.Order}_*.pdf) i {documents.Folder}.", retry: true);
                return;
            case OrderDocumentLoadStatus.Unreadable:
                Message($"Produktionslisten for ordre {barcode.Order} kan ikke åbnes", load.Error ?? "Filen kan ikke læses", retry: true);
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
        HasSheetData = load.Position is not null;
        State = DocumentState.Ready;
        if (load.Position is null)
        {
            Warning = $"Position {Sheet.Position} står ikke i produktionslisten. Hele PDF'en vises.";
            OpenPages(0, canLeave: false);
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

    void OpenPages(int start, bool canLeave = true)
    {
        if (_load is not { Pdf: not null, Document: { } doc } load || _cts is not { } cts) return;
        CanLeavePages = canLeave;
        if (Pages.Count == 0)
        {
            // Every page in the samples has the same size; the drawing box knows it.
            var box = doc.Positions.Select(p => p.Drawing).FirstOrDefault(d => d is not null);
            var (w, h) = box is null ? (839.0, 592.0) : (box.PageWidth, box.PageHeight);
            var position = load.Position;
            for (var i = 0; i < doc.PageCount; i++)
            {
                var isPosition = position is not null && i >= position.PageIndex && i < position.PageIndex + position.PageCount;
                Pages.Add(new PdfPageViewModel(i, doc.PageCount, isPosition, w, h));
            }
            _ = RenderPagesAsync(load, start, cts.Token);
        }
        StartPage = Math.Clamp(start, 0, Math.Max(0, Pages.Count - 1));
        ShowingPages = true;
    }

    void ClosePages() => ShowingPages = false;

    // From the position's page on, then the pages before it.
    async Task RenderPagesAsync(OrderDocumentLoad load, int start, CancellationToken ct)
    {
        var pages = Pages.ToList();
        foreach (var page in pages.Skip(start).Concat(pages.Take(start)))
        {
            if (ct.IsCancellationRequested) return;
            try { page.Image = await PdfRender.PageAsync(load, page.Index); }
            catch (Exception ex)
            {
                Log.Write($"Page {page.Index + 1} of {load.Path} failed: {ex.Message}");
                page.Failed = true;
            }
        }
    }

    void Message(string title, string detail, bool retry)
    {
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
