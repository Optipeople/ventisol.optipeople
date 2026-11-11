using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class StationLayoutTests
{
    static readonly string[] Ids = [.. Enumerable.Range(1, 7).Select(n => $"s{n}")];
    static StationLayout Seven() => StationLayout.Default(Ids);

    [Fact]
    public void Default_is_four_and_three_with_the_last_one_wide()
    {
        var l = Seven();
        Assert.Equal(new TilePlace("s1", 0, 0, 3, 3), l["s1"]);
        Assert.Equal(new TilePlace("s5", 0, 3, 3, 3), l["s5"]);
        Assert.Equal(new TilePlace("s7", 6, 3, 6, 3), l["s7"]);
        Assert.True(l.IsValidFor(Ids));
    }

    [Fact]
    public void A_block_cannot_grow_into_another_but_can_after_the_other_shrinks()
    {
        var l = Seven();
        Assert.False(l.TryResize("s1", 4, 3));
        Assert.True(l.TryResize("s2", 2, 3));
        Assert.True(l.TryMove("s2", 4, 0));
        Assert.True(l.TryResize("s1", 4, 3));
        Assert.True(l.IsValidFor(Ids));
    }

    [Fact]
    public void Moves_and_resizes_stay_inside_the_grid_and_above_the_minimum()
    {
        var l = Seven();
        Assert.False(l.TryMove("s7", 7, 3));
        Assert.False(l.TryResize("s1", 1, 3));
        Assert.Equal(new TilePlace("s1", 0, 0, 3, 3), l["s1"]);
    }

    [Fact]
    public void Swap_trades_places_and_sizes()
    {
        var l = Seven();
        l.Swap("s1", "s7");
        Assert.Equal(new TilePlace("s1", 6, 3, 6, 3), l["s1"]);
        Assert.Equal(new TilePlace("s7", 0, 0, 3, 3), l["s7"]);
        Assert.Equal("s7", l.IdAt(1, 1));
    }

    [Fact]
    public void A_saved_layout_for_other_blocks_is_not_valid()
    {
        Assert.False(Seven().IsValidFor([.. Ids, "w1"]));
    }

    [Fact]
    public void Add_finds_the_first_free_spot_and_shrinks_to_fit()
    {
        var l = Seven();
        Assert.False(l.TryAdd("w1", 3, 2)); // The default fills the screen.

        Assert.True(l.TryResize("s7", 3, 3));
        Assert.True(l.TryAdd("w1", 4, 2));
        Assert.Equal(new TilePlace("w1", 9, 3, 3, 2), l["w1"]);
        Assert.True(l.IsValidFor([.. Ids, "w1"]));

        l.Remove("w1");
        Assert.True(l.IsValidFor(Ids));
    }

    [Fact]
    public void Restore_keeps_hidden_stations_off_the_screen()
    {
        var l = Seven();
        l.Remove("s3");
        var r = StationLayout.Restore(l.Tiles, Ids, ["s3"], []);
        Assert.NotNull(r);
        Assert.Equal(["s3"], r.Value.Hidden);
        Assert.Null(r.Value.Layout.Tiles.FirstOrDefault(t => t.Id == "s3"));
    }

    [Fact]
    public void Restore_places_a_new_station_in_a_free_spot_or_starts_from_the_default_when_full()
    {
        var l = Seven();
        l.Remove("s3");
        var r = StationLayout.Restore(l.Tiles, [.. Ids, "s8"], [], []);
        Assert.NotNull(r);
        Assert.Empty(r.Value.Hidden);
        Assert.Equal(StationLayout.Default([.. Ids, "s8"]).Tiles, r.Value.Layout.Tiles);

        // "Nulstil" with five stations fills the screen; a sixth still shows up.
        string[] five = [.. Ids[..5]];
        r = StationLayout.Restore(StationLayout.Default(five).Tiles, [.. five, "s6"], [], []);
        Assert.NotNull(r);
        Assert.Empty(r.Value.Hidden);
        Assert.True(r.Value.Layout.IsValidFor([.. five, "s6"]));
    }

    [Fact]
    public void Restore_from_the_default_keeps_hidden_stations_off_and_widgets_where_there_is_room()
    {
        TilePlace[] saved = [new("s1", 0, 0, 4, 6), new("s2", 4, 0, 4, 6), new("w1", 8, 0, 4, 6)];
        var r = StationLayout.Restore(saved, ["s1", "s2", "s3", "s4"], ["s4"], ["w1"]);
        Assert.NotNull(r);
        Assert.Equal(["s4"], r.Value.Hidden);
        Assert.Equal(new TilePlace("s3", 6, 0, 6, 3), r.Value.Layout["s3"]);
        Assert.Equal(new TilePlace("w1", 0, 3, 4, 3), r.Value.Layout["w1"]);
        Assert.True(r.Value.Layout.IsValidFor(["s1", "s2", "s3", "w1"]));
    }

    [Fact]
    public void Restore_forgets_stations_no_longer_set_up_and_refuses_widgets_without_a_tile()
    {
        var r = StationLayout.Restore(Seven().Tiles, Ids, ["s9"], []);
        Assert.NotNull(r);
        Assert.Empty(r.Value.Hidden);
        Assert.Null(StationLayout.Restore(Seven().Tiles, Ids, [], ["w1"]));

        // s7 was taken out of the setup: its tile goes, the rest of the layout and the hidden list stay.
        var l = Seven();
        l.Remove("s1");
        Assert.True(l.TryAdd("w1", 3, 3));
        r = StationLayout.Restore(l.Tiles, Ids[..6], ["s1"], ["w1"]);
        Assert.NotNull(r);
        Assert.Equal(["s1"], r.Value.Hidden);
        Assert.Equal(new TilePlace("w1", 0, 0, 3, 3), r.Value.Layout["w1"]);
        Assert.True(r.Value.Layout.IsValidFor([.. Ids[1..6], "w1"]));
    }
}
