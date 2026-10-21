using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;

namespace Ventisol.Station.ViewModels;

public enum FlashKind { None, In, Out, Rejected }

// One tile on the screen: a station, what it works on, for how long, and whether its scanner is there.
// A scan answers on the tile itself, where the operator is already looking.
public sealed partial class StationViewModel(StationConfig config) : ObservableObject
{
    static readonly TimeSpan FlashOk = TimeSpan.FromSeconds(1.6);
    static readonly TimeSpan FlashRejected = TimeSpan.FromSeconds(4);

    readonly StationState _state = new(config);
    DateTimeOffset _flashUntil;

    public StationConfig Config => config;
    public int Number => config.Number;
    public string Name => config.Name;

    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial string? Code { get; private set; }
    [ObservableProperty] public partial string? OrderNumber { get; private set; }
    [ObservableProperty] public partial string? DetailText { get; private set; }
    [ObservableProperty] public partial string ElapsedText { get; private set; } = "";
    [ObservableProperty] public partial bool ScannerConnected { get; set; } = true;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsFlashOk), nameof(IsFlashWarn))]
    public partial FlashKind Flash { get; private set; }
    [ObservableProperty] public partial string FlashTitle { get; private set; } = "";
    [ObservableProperty] public partial string FlashDetail { get; private set; } = "";

    public bool IsFlashOk => Flash is FlashKind.In or FlashKind.Out;
    public bool IsFlashWarn => Flash is FlashKind.Rejected;

    public Barcode? Current => _state.Current;
    public StationState State => _state;

    public ScanResult Scan(Barcode barcode, DateTimeOffset now)
    {
        var result = _state.Scan(barcode, now);
        var element = $"Ordre {barcode.Order} · {barcode.PositionLabel} · stk. {barcode.Piece}";
        switch (result.Kind)
        {
            case ScanKind.In:
                IsBusy = true;
                Code = barcode.Raw;
                OrderNumber = barcode.Order.ToString();
                DetailText = $"{barcode.PositionLabel} · stk. {barcode.Piece}";
                ElapsedText = Format.Duration(TimeSpan.Zero);
                ShowFlash(FlashKind.In, "Scannet ind", element, now);
                break;
            case ScanKind.Out:
                Clear();
                ShowFlash(FlashKind.Out, "Scannet ud", $"{element} · {Format.Duration(result.Duration ?? TimeSpan.Zero)}", now);
                break;
            default:
                var current = _state.Current!;
                ShowFlash(FlashKind.Rejected, $"Scan først {current.Order} ud",
                    $"{current.PositionLabel} · stk. {current.Piece} er stadig i gang", now);
                break;
        }
        return result;
    }

    public void Unreadable(string raw, DateTimeOffset now) =>
        ShowFlash(FlashKind.Rejected, "Ukendt stregkode", $"{raw} er ikke en elementlabel", now);

    public void Tick(DateTimeOffset now)
    {
        if (IsBusy) ElapsedText = Format.Duration(_state.Elapsed(now));
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

    void Clear()
    {
        IsBusy = false;
        Code = OrderNumber = DetailText = null;
        ElapsedText = "";
    }
}
