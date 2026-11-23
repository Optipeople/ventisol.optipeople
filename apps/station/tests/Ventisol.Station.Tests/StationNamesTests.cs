using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class StationNamesTests
{
    static readonly Guid Ten = Guid.Parse("201f8152-cbd1-4a3b-c9ac-08df3f1a322f");
    static readonly Guid Packing = Guid.Parse("a7531d35-24be-4336-f511-08df3f1a4723");
    static readonly Guid Gone = Guid.Parse("6956a285-3c97-4daa-c9ad-08df3f1a322f");

    static readonly StationSetup[] Stations =
    [
        new(1, "Station 10", StationKind.Assembly, Ten),
        new(2, "Station 20", StationKind.Assembly),
        new(3, "Pakning", StationKind.Packing, Packing),
        new(4, "Station 40", StationKind.Assembly, Gone),
    ];

    [Fact]
    public void A_station_takes_its_machines_name()
    {
        var renamed = StationNames.Renamed(Stations, [(Ten, " Montage 10 "), (Packing, "Pakning")]);

        Assert.Equal(new Dictionary<int, string> { [1] = "Montage 10" }, renamed);
    }

    [Fact]
    public void Without_a_machine_or_a_name_in_OptiPeople_the_local_name_stays()
    {
        // Station 2 has no machine, station 4's machine is not on the account, station 3's has no name.
        Assert.Empty(StationNames.Renamed(Stations, [(Packing, "  "), (Guid.NewGuid(), "Station 20")]));
    }

    [Fact]
    public void Apply_changes_only_the_names()
    {
        var settings = StationSettings.Default with { Stations = Stations, MarkAfterHours = 6 };

        var applied = StationNames.Apply(settings, new Dictionary<int, string> { [3] = "Pak 1" });

        Assert.Equal("Pak 1", applied.Stations[2].Name);
        Assert.Equal(Stations[2] with { Name = "Pak 1" }, applied.Stations[2]);
        Assert.Equal(Stations.Where(s => s.Number != 3), applied.Stations.Where(s => s.Number != 3));
        Assert.Equal(6, applied.MarkAfterHours);
        Assert.Same(settings, StationNames.Apply(settings, new Dictionary<int, string>()));
    }

    [Fact]
    public void A_renamed_station_keeps_what_is_in_progress()
    {
        var state = new StationState(new StationConfig(1, "Station 10"));
        Assert.True(Barcode.TryParse("058556050103", out var code));
        state.Scan(code, DateTimeOffset.Now);

        state.Rename("Montage 10");

        Assert.Equal("Montage 10", state.Station.Name);
        Assert.Single(state.Active);
    }
}
