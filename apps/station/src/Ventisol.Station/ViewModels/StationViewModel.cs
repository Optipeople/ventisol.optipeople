using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;

namespace Ventisol.Station.ViewModels;

public enum FlashKind { None, In, Out, Switched, Rejected }

// Why an element ended without a scan: stopped in OptiPeople, or with the stop button on its tile.
public enum StopReason { OptiPeople, Manual }

// One tile on the screen: a station, what it works on, for how long, and whether its scanner is there.
// A scan answers on the tile itself, where the operator is already looking. At a station with
// "Max i gang" 1 the tile shows its one element big; with more, a row per element in progress (Rows).
public sealed partial class StationViewModel(StationConfig config) : ObservableObject
{
    static readonly TimeSpan FlashOk = TimeSpan.FromSeconds(1.6);
    static readonly TimeSpan FlashRejected = TimeSpan.FromSeconds(4);

    readonly StationState _state = new(config);
    DateTimeOffset _flashUntil;

    public StationConfig Config => config;
    public int Number => config.Number;
    public string Name => config.Name;

    public int MaxActive => _state.MaxActive;
    // Several elements at once: the tile shows Rows, each with its own timer and stop button.
    public bool IsMulti => MaxActive > 1;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowsStop))]
    public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial string? Code { get; private set; }
    [ObservableProperty] public partial string? OrderNumber { get; private set; }
    [ObservableProperty] public partial string? DetailText { get; private set; }
    [ObservableProperty] public partial string ElapsedText { get; private set; } = "";
    // At a station with several: "3 i gang", the state line over the rows.
    [ObservableProperty] public partial string CountText { get; private set; } = "";
    [ObservableProperty] public partial bool ScannerConnected { get; set; } = true;
    // Order documents are set up: the tile shows a button for its element's document.
    [ObservableProperty] public partial bool DocumentsOn { get; set; }
    // A scan station: the tile can stop its element by hand. A viewer records nothing, so never there.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowsStop))]
    public partial bool StopOn { get; set; }

    // "Marker efter (timer)": an element in progress longer than this is marked on its row, as one
    // forgotten at a station with several would take a share of the station's time in the reports.
    public TimeSpan MarkAfter { get; set; } = TimeSpan.FromHours(StationSettings.DefaultMarkAfterHours);
    public string MarkText => $"i gang over {(int)MarkAfter.TotalHours} t";

    // The tile's own stop button, for its one element. With several, each row has its own.
    public bool ShowsStop => StopOn && IsBusy && !IsMulti;

    // The elements in progress, oldest first, at a station with several (empty at one with 1).
    public ObservableCollection<ActiveRowViewModel> Rows { get; } = [];

    // The tile has a slot per element it may have in progress, up to six (more only while more are
    // in progress), so a row keeps its size as elements come and go.
    public int RowSlots => Math.Max(Math.Min(MaxActive, 6), Rows.Count);

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsFlashOk), nameof(IsFlashWarn))]
    public partial FlashKind Flash { get; private set; }
    [ObservableProperty] public partial string FlashTitle { get; private set; } = "";
    [ObservableProperty] public partial string FlashDetail { get; private set; } = "";

    public bool IsFlashOk => Flash is FlashKind.In or FlashKind.Out or FlashKind.Switched;
    public bool IsFlashWarn => Flash is FlashKind.Rejected;

    // The element scanned in last (at a station with 1, the one in progress).
    public Barcode? Current => _state.Current;
    public StationState State => _state;

    public bool Has(string raw) => _state.Has(raw);

    static string Element(Barcode b) => $"Ordre {b.Order} · {b.PositionLabel} · stk. {b.Piece}";

    public ScanResult Scan(Barcode barcode, DateTimeOffset now)
    {
        var result = _state.Scan(barcode, now);
        var element = Element(barcode);
        switch (result.Kind)
        {
            case ScanKind.In:
                Show(now);
                ShowFlash(FlashKind.In, IsMulti ? $"Startet – {_state.Active.Count} i gang" : "Scannet ind", element, now);
                break;
            case ScanKind.Out:
                Show(now);
                ShowFlash(FlashKind.Out, "Scannet ud", $"{element} · {Format.Duration(result.Duration ?? TimeSpan.Zero)}", now);
                break;
            case ScanKind.Switched:
                // Stopped old order, started new one
                Show(now);
                var prev = result.Previous!;
                ShowFlash(FlashKind.Switched, $"Skiftet fra {prev.Order}",
                    $"{prev.PositionLabel} stk. {prev.Piece} stoppet · {Format.Duration(result.Duration ?? TimeSpan.Zero)}", now);
                break;
            default:
                // As many in progress as the station takes: nothing is started, nothing is stored.
                ShowFlash(FlashKind.Rejected, $"Maks {MaxActive} i gang – scan en ud først", $"{element} er ikke startet", now);
                break;
        }
        return result;
    }

    // An element in progress ends without a scan (stopped in OptiPeople, or by hand on the tile):
    // the same Out as a scan of it would give, with a flash that says why. Null when it is not in
    // progress here.
    public ScanResult? Stop(string raw, StopReason reason, DateTimeOffset now)
    {
        if (_state.Find(raw) is not { } running) return null;
        var barcode = running.Barcode;
        var result = _state.Scan(barcode, now);
        Show(now);
        ShowFlash(FlashKind.Out, reason == StopReason.Manual ? "Stoppet manuelt" : "Stoppet i OptiPeople",
            $"{Element(barcode)} · {Format.Duration(result.Duration ?? TimeSpan.Zero)}", now);
        return result;
    }

    // What OptiCloud says this station is working on, after a restart or on a viewer. No flash:
    // nobody just scanned.
    public void Restore(IReadOnlyList<ActiveElement> active, DateTimeOffset now)
    {
        if (active.Count == 0)
        {
            if (_state.IsBusy) { _state.Reset(); Show(now); }
            return;
        }
        if (_state.Active.SequenceEqual(active.OrderBy(a => a.Since).TakeLast(MaxActive))) return;
        _state.Restore(active);
        Show(now);
    }

    public void Unreadable(string raw, DateTimeOffset now) =>
        ShowFlash(FlashKind.Rejected, "Ukendt stregkode", $"{raw} er ikke en elementlabel", now);

    public void Tick(DateTimeOffset now)
    {
        if (IsBusy) ElapsedText = Format.Duration(_state.Elapsed(now));
        foreach (var r in Rows) r.Tick(now, MarkAfter);
        if (Flash != FlashKind.None && now >= _flashUntil) Flash = FlashKind.None;
    }

    void ShowFlash(FlashKind kind, string title, string detail, DateTimeOffset now)
    {
        FlashTitle = title;
        FlashDetail = detail;
        _flashUntil = now + (kind == FlashKind.Rejected ? FlashRejected : FlashOk);
        // A second scan while one shows: drop to None first, so the tile flashes again.
        if (Flash != FlashKind.None) Flash = FlashKind.None;
        Flash = kind;
    }

    // The tile after a change: the element scanned in last, and at a station with several, a row
    // per element. A row still in progress keeps its view model.
    void Show(DateTimeOffset now)
    {
        if (_state.Current is { } current)
        {
            IsBusy = true;
            Code = current.Raw;
            OrderNumber = current.Order.ToString();
            DetailText = $"{current.PositionLabel} · stk. {current.Piece}";
            ElapsedText = Format.Duration(_state.Elapsed(now));
        }
        else
        {
            IsBusy = false;
            Code = OrderNumber = DetailText = null;
            ElapsedText = "";
        }
        CountText = $"{_state.Active.Count} i gang";
        if (!IsMulti) return;

        var keep = Rows.Where(r => _state.Active.Contains(r.Element)).ToDictionary(r => r.Element);
        Rows.Clear();
        foreach (var a in _state.Active)
        {
            var row = keep.GetValueOrDefault(a) ?? new ActiveRowViewModel(this, a);
            row.Tick(now, MarkAfter);
            Rows.Add(row);
        }
        OnPropertyChanged(nameof(RowSlots));
    }
}

// One element in progress on the tile of a station with several: its order, position and piece,
// its own timer and its own stop button. Marked once it has been in progress longer than "Marker efter".
public sealed partial class ActiveRowViewModel(StationViewModel station, ActiveElement element) : ObservableObject
{
    public StationViewModel Station => station;
    public ActiveElement Element => element;
    public Barcode Barcode => element.Barcode;
    public string Code => element.Barcode.Raw;
    public string OrderNumber => element.Barcode.Order.ToString();
    public string DetailText => $"{element.Barcode.PositionLabel} · stk. {element.Barcode.Piece}";

    [ObservableProperty] public partial string ElapsedText { get; private set; } = "";
    [ObservableProperty] public partial bool IsMarked { get; private set; }

    internal void Tick(DateTimeOffset now, TimeSpan markAfter)
    {
        var elapsed = element.Elapsed(now);
        ElapsedText = Format.Duration(elapsed < TimeSpan.Zero ? TimeSpan.Zero : elapsed);
        IsMarked = elapsed > markAfter;
    }
}
