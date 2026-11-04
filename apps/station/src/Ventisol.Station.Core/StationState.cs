namespace Ventisol.Station.Core;

public enum ScanKind { In, Out, Switched, Rejected }

public sealed record ScanResult(ScanKind Kind, StationConfig Station, Barcode Barcode, DateTimeOffset At, TimeSpan? Duration = null, string? Reason = null)
{
    // When switching orders, this holds the previous order that was stopped.
    public Barcode? Previous { get; init; }
}

// What a station is working on. The first scan of an element starts it,
// a second scan of the same element ends it. A different element while one
// is active stops the current and starts the new.
public sealed class StationState(StationConfig station)
{
    public StationConfig Station { get; } = station;
    public Barcode? Current { get; private set; }
    public DateTimeOffset? StartedAt { get; private set; }

    public bool IsBusy => Current is not null;

    public TimeSpan Elapsed(DateTimeOffset now) => StartedAt is { } t ? now - t : TimeSpan.Zero;

    public ScanResult Scan(Barcode barcode, DateTimeOffset now)
    {
        if (Current is null)
        {
            Current = barcode;
            StartedAt = now;
            return new ScanResult(ScanKind.In, Station, barcode, now);
        }

        // Same barcode: stop the current order
        if (Current.Raw == barcode.Raw)
        {
            var duration = Elapsed(now);
            Current = null;
            StartedAt = null;
            return new ScanResult(ScanKind.Out, Station, barcode, now, duration);
        }

        // Different barcode: stop current, start new
        var previous = Current;
        var previousDuration = Elapsed(now);
        Current = barcode;
        StartedAt = now;
        return new ScanResult(ScanKind.Switched, Station, barcode, now, previousDuration) { Previous = previous };
    }

    // Back to what OptiCloud holds, after a restart or on a viewer: this element in progress since then.
    public void Restore(Barcode barcode, DateTimeOffset startedAt)
    {
        Current = barcode;
        StartedAt = startedAt;
    }

    public void Reset()
    {
        Current = null;
        StartedAt = null;
    }
}
