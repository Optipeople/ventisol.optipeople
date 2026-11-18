namespace Ventisol.Station.Core;

public enum StationKind { Assembly, Packing }

// One scanner belongs to one station. Number is the scanner number, 1 to 7.
// MaxActive is the station's "Max i gang": how many elements may be in progress there at once.
// 1 (the default) is one at a time: a different barcode while busy switches to it.
public sealed record StationConfig(int Number, string Name, StationKind Kind = StationKind.Assembly, int MaxActive = 1)
{
    // The most "Max i gang" can be set to. On the floor it is up to 4, at most 6.
    public const int MaxActiveLimit = 20;

    // The stations in the proposal. Moves to the setup screen later.
    public static IReadOnlyList<StationConfig> Defaults { get; } =
    [
        new(1, "Station 10"),
        new(2, "Station 20"),
        new(3, "Station 30"),
        new(4, "Station 40"),
        new(5, "Montagebord 1"),
        new(6, "Montagebord 2"),
        new(7, "Pakning", StationKind.Packing),
    ];
}
