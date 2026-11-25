using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.ViewModels;

public enum FlashKind { None, In, Out, Switched, Rejected, ShiftEnd }

// Why an element ended without a scan: stopped in OptiPeople, with the stop button on its tile, or at shift end.
public enum StopReason { OptiPeople, Manual, ShiftEnd }

// One tile on the screen: a station, what it works on, for how long, and whether its scanner is there.
// A scan answers on the tile itself, where the operator is already looking. At a station with
// "Max i gang" 1 the tile shows its one element big; with more, a row per element in progress (Rows).
public sealed partial class StationViewModel(StationConfig config) : ObservableObject
{
    static readonly TimeSpan FlashOk = TimeSpan.FromSeconds(1.6);
    static readonly TimeSpan FlashRejected = TimeSpan.FromSeconds(4);

    readonly StationState _state = new(config);
    DateTimeOffset _flashUntil;

    public StationConfig Config => _state.Station;
    public int Number => config.Number;
    public string Name => _state.Station.Name;

    // Its machine's name in OptiPeople changed (StationNames).
    public void Rename(string name)
    {
        if (name == Name) return;
        _state.Rename(name);
        OnPropertyChanged(nameof(Name));
        OnPropertyChanged(nameof(Config));
    }

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
    public bool IsFlashWarn => Flash is FlashKind.Rejected or FlashKind.ShiftEnd;

    // ----- Shift end (docs/plan-shift-end.md §2, §6.5)

    // Grace or Overtime: the amber band with the countdown and "Arbejder videre" (scan station only).
    // Stopped: the idle line "Stoppet ved vagtskifte 14:00", until the next scan here or the next shift start.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowsShiftEndBand), nameof(ShowsStoppedLine))]
    public partial ShiftEndState ShiftEndState { get; private set; }
    [ObservableProperty] public partial string ShiftEndTitle { get; private set; } = "";
    [ObservableProperty] public partial string ShiftEndText { get; private set; } = "";
    [ObservableProperty] public partial string StoppedText { get; private set; } = "";

    public bool ShowsShiftEndBand => ShiftEndState is ShiftEndState.Grace or ShiftEndState.Overtime;
    public bool ShowsStoppedLine => ShiftEndState == ShiftEndState.Stopped;

    // The countdown's stop, while one is coming (scan station only).
    ShiftEndDue? _due;
    // The latest stop at shift end here (this PC's, or read from the rows), for the idle line and "Startet igen".
    AutoStop? _autoStop;
    // The stop whose idle line has gone (a scan here, or the next shift start).
    DateTimeOffset? _lineGoneFor;

    public AutoStop? LastAutoStop => _autoStop;

    // The element scanned in last (at a station with 1, the one in progress).
    public Barcode? Current => _state.Current;
    public StationState State => _state;

    public bool Has(string raw) => _state.Has(raw);

    static string Element(Barcode b) => $"Ordre {b.Order} · {b.PositionLabel} · stk. {b.Piece}";

    public ScanResult Scan(Barcode barcode, DateTimeOffset now)
    {
        var result = _state.Scan(barcode, now);
        var element = Element(barcode);
        StoppedLineGone(now);
        switch (result.Kind)
        {
            case ScanKind.In when StoppedAtShiftEnd(barcode, now) is { } stoppedAt:
                Show(now);
                ShowFlash(FlashKind.In, ShiftEndTexts.Restarted, ShiftEndTexts.RestartedDetail(stoppedAt, now), now);
                break;
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
        var title = reason switch
        {
            StopReason.Manual => "Stoppet manuelt",
            StopReason.ShiftEnd => ShiftEndTexts.Stopped(now),
            _ => "Stoppet i OptiPeople",
        };
        ShowFlash(reason == StopReason.ShiftEnd ? FlashKind.ShiftEnd : FlashKind.Out, title,
            $"{Element(barcode)} · {Format.Duration(result.Duration ?? TimeSpan.Zero)}", now);
        return result;
    }

    // Every element in progress here stops at at, a shift end's stop (an Out each, oldest first, each
    // with its derived ScanId). The flash says so, then the idle line until the next scan or shift start.
    public IReadOnlyList<ScanResult> ShiftEnd(DateTimeOffset at, DateTimeOffset now)
    {
        var results = _state.StopAll(at, ScanEventKind.ShiftEnd);
        if (results.Count == 0) return results;
        _due = null;
        _autoStop = new AutoStop(at, [.. results.Select(r => r.Barcode)]);
        Show(now);
        ShowFlash(FlashKind.ShiftEnd, ShiftEndTexts.Stopped(at), Elements(_autoStop.Elements), now);
        ShowShiftEnd(now);
        return results;
    }

    // The countdown, from the window's check (scan station only); null when no stop is coming.
    public void ShiftEndComing(ShiftEndDue? due, DateTimeOffset now)
    {
        _due = due;
        ShowShiftEnd(now);
    }

    // The latest stop at shift end here as the rows have it (ReplayResult.AutoStopped), on start and on
    // a viewer at each read. flash: the stop is new to this screen (a viewer seeing the row arrive).
    // A stop this screen already knows keeps its idle line as it is.
    public void ApplyAutoStop(AutoStop? stop, DateTimeOffset now, bool flash)
    {
        if (stop is null || _autoStop is { } known && stop.At <= known.At) return;
        _autoStop = stop;
        if (flash && stop.Elements.Count > 0) ShowFlash(FlashKind.ShiftEnd, ShiftEndTexts.Stopped(stop.At), Elements(stop.Elements), now);
        ShowShiftEnd(now);
    }

    // The idle line goes: a scan here (or, on a viewer, a row after the stop), or the next shift start.
    public void StoppedLineGone(DateTimeOffset now)
    {
        if (_autoStop is not { } stop || _lineGoneFor == stop.At) return;
        _lineGoneFor = stop.At;
        ShowShiftEnd(now);
    }

    // "Ordre 58556 · Pos. 5 · stk. 3", and how many more.
    static string Elements(IReadOnlyList<Barcode> elements) =>
        Element(elements[0]) + (elements.Count > 1 ? $" og {elements.Count - 1} til" : "");

    // When the element was stopped at a shift end here, if that was the station's last stop and within the window.
    DateTimeOffset? StoppedAtShiftEnd(Barcode barcode, DateTimeOffset now) =>
        _autoStop is { } stop && now - stop.At <= CloudSync.Window && stop.Elements.Any(b => b.Raw == barcode.Raw) ? stop.At : null;

    void ShowShiftEnd(DateTimeOffset now)
    {
        var state = ShiftEndTexts.StateOf(_due, now);
        if (_due is { } due && state != ShiftEndState.None)
        {
            ShiftEndTitle = ShiftEndTexts.Title(state, due);
            ShiftEndText = ShiftEndTexts.Countdown(due.DueAt, now);
        }
        else if (!IsBusy && _autoStop is { } stop && _lineGoneFor != stop.At && now - stop.At <= CloudSync.Window)
        {
            StoppedText = ShiftEndTexts.Stopped(stop.At);
            state = ShiftEndState.Stopped;
        }
        ShiftEndState = state;
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
        // The same elements: only their In's ScanIds may be new, kept for the stop at shift end.
        if (_state.Active.SequenceEqual(active.OrderBy(a => a.Since).TakeLast(MaxActive)))
        {
            foreach (var a in active)
                if (a.InScanId is { } id && _state.Find(a.Barcode.Raw) is { InScanId: null }) _state.NoteInScanId(a.Barcode.Raw, id);
            return;
        }
        _state.Restore(active);
        Show(now);
    }

    public void Unreadable(string raw, DateTimeOffset now)
    {
        StoppedLineGone(now);
        ShowFlash(FlashKind.Rejected, "Ukendt stregkode", $"{raw} er ikke en elementlabel", now);
    }

    public void Tick(DateTimeOffset now)
    {
        if (IsBusy) ElapsedText = Format.Duration(_state.Elapsed(now));
        if (_due is not null || ShiftEndState != ShiftEndState.None) ShowShiftEnd(now);
        foreach (var r in Rows) r.Tick(now, MarkAfter);
        if (Flash != FlashKind.None && now >= _flashUntil) Flash = FlashKind.None;
    }

    void ShowFlash(FlashKind kind, string title, string detail, DateTimeOffset now)
    {
        FlashTitle = title;
        FlashDetail = detail;
        _flashUntil = now + (kind is FlashKind.Rejected or FlashKind.ShiftEnd ? FlashRejected : FlashOk);
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
