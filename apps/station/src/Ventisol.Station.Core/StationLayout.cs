namespace Ventisol.Station.Core;

// Where a block sits on the screen grid, in cells. A block is a station or a widget, by id.
public sealed record TilePlace(string Id, int Column, int Row, int ColumnSpan, int RowSpan)
{
    public bool Overlaps(TilePlace o) =>
        Column < o.Column + o.ColumnSpan && o.Column < Column + ColumnSpan &&
        Row < o.Row + o.RowSpan && o.Row < Row + RowSpan;

    public bool Contains(int column, int row) =>
        column >= Column && column < Column + ColumnSpan && row >= Row && row < Row + RowSpan;
}

// The screen as a fine grid the blocks snap to. Blocks never overlap and never leave
// the grid: a move, resize or add that would break that is refused, and nothing changes.
public sealed class StationLayout
{
    public const int Columns = 12, Rows = 6;
    public const int MinSpan = 2;

    readonly List<TilePlace> _tiles;

    public StationLayout(IEnumerable<TilePlace> tiles) => _tiles = [.. tiles];

    public IReadOnlyList<TilePlace> Tiles => _tiles;

    public TilePlace this[string id] => _tiles.Single(t => t.Id == id);

    // Four blocks to a row, 3 x 3 cells each. The last one takes what is left of its row.
    public static StationLayout Default(IEnumerable<string> ids)
    {
        var list = ids.ToList();
        const int perRow = 4, width = Columns / perRow, height = Rows / 2;
        return new(list.Select((id, i) =>
        {
            var span = i == list.Count - 1 ? Columns - i % perRow * width : width;
            return new TilePlace(id, i % perRow * width, i / perRow * height, span, height);
        }));
    }

    // A saved layout is only used if it still fits: exactly these blocks, inside the grid, no overlaps.
    public bool IsValidFor(IEnumerable<string> ids) =>
        _tiles.Select(t => t.Id).Order().SequenceEqual(ids.Order()) &&
        _tiles.All(Fits) &&
        !_tiles.Any(a => _tiles.Any(b => a != b && a.Overlaps(b)));

    // A saved layout, where stations not on it were taken off the screen on purpose (hidden). A station set up
    // since it was saved gets the first free spot, or is hidden too when there is none. Hidden stations that are
    // no longer set up are forgotten. Null if the saved layout doesn't fit, so the caller starts from the default.
    public static (StationLayout Layout, IReadOnlyList<string> Hidden)? Restore(
        IEnumerable<TilePlace> saved, IReadOnlyList<string> stations, IEnumerable<string> hidden, IEnumerable<string> widgets)
    {
        var layout = new StationLayout(saved);
        var off = hidden.Where(stations.Contains).ToHashSet();
        var placed = layout._tiles.Select(t => t.Id).ToHashSet();
        if (!layout.IsValidFor([.. placed.Where(id => stations.Contains(id) && !off.Contains(id)), .. widgets])) return null;
        foreach (var id in stations.Where(id => !placed.Contains(id) && !off.Contains(id)))
            if (!layout.TryAdd(id, Columns / 4, Rows / 2)) off.Add(id);
        return (layout, [.. stations.Where(off.Contains)]);
    }

    public string? IdAt(int column, int row) => _tiles.FirstOrDefault(t => t.Contains(column, row))?.Id;

    public bool TryMove(string id, int column, int row) => TryPlace(this[id] with { Column = column, Row = row });

    public bool TryResize(string id, int columnSpan, int rowSpan) =>
        columnSpan >= MinSpan && rowSpan >= MinSpan && TryPlace(this[id] with { ColumnSpan = columnSpan, RowSpan = rowSpan });

    // Dropping one block on another trades their places and sizes, so a full screen can be rearranged.
    public void Swap(string a, string b)
    {
        var (pa, pb) = (this[a], this[b]);
        Replace(pa with { Column = pb.Column, Row = pb.Row, ColumnSpan = pb.ColumnSpan, RowSpan = pb.RowSpan });
        Replace(pb with { Column = pa.Column, Row = pa.Row, ColumnSpan = pa.ColumnSpan, RowSpan = pa.RowSpan });
    }

    // A new block goes in the first free spot that holds the size asked for, read like text:
    // left to right, top to bottom. Smaller sizes are tried down to the minimum. False if there is no room.
    public bool TryAdd(string id, int columnSpan, int rowSpan)
    {
        for (var w = columnSpan; w >= MinSpan; w--)
        for (var h = rowSpan; h >= MinSpan; h--)
        for (var r = 0; r + h <= Rows; r++)
        for (var c = 0; c + w <= Columns; c++)
        {
            var p = new TilePlace(id, c, r, w, h);
            if (_tiles.Any(t => t.Overlaps(p))) continue;
            _tiles.Add(p);
            return true;
        }
        return false;
    }

    public void Remove(string id) => _tiles.RemoveAll(t => t.Id == id);

    bool TryPlace(TilePlace p)
    {
        if (!Fits(p) || _tiles.Any(t => t.Id != p.Id && t.Overlaps(p))) return false;
        Replace(p);
        return true;
    }

    static bool Fits(TilePlace p) =>
        p.Column >= 0 && p.Row >= 0 && p.ColumnSpan >= MinSpan && p.RowSpan >= MinSpan &&
        p.Column + p.ColumnSpan <= Columns && p.Row + p.RowSpan <= Rows;

    void Replace(TilePlace p) => _tiles[_tiles.FindIndex(t => t.Id == p.Id)] = p;
}
