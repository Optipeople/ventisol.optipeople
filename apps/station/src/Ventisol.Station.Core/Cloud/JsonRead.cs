using System.Globalization;
using System.Text.Json;

namespace Ventisol.Station.Core.Cloud;

// Reading OptiCloud's JSON without trusting its shape: names match case-insensitively, and an
// id or a number may come as a string or a number.
static class JsonRead
{
    public static JsonElement? Prop(this JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        foreach (var p in e.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) return p.Value;
        return null;
    }

    public static string? Str(this JsonElement e, string name) => e.Prop(name) is { } v ? Text(v) : null;

    public static Guid? Guid(this JsonElement e, string name) =>
        System.Guid.TryParse(e.Str(name), out var g) && g != System.Guid.Empty ? g : null;

    public static int? Int(this JsonElement e, string name) => ToInt(e.Str(name));

    // A value as text: strings as they are, numbers and booleans as written, null as null.
    public static string? Text(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => v.GetRawText(),
    };

    public static int? ToInt(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) return i;
        return decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var d) && d == decimal.Truncate(d) && d is >= int.MinValue and <= int.MaxValue
            ? (int)d : null;
    }

    // A list, also when the server wraps it in an object ({items: [...]}).
    public static IEnumerable<JsonElement> List(JsonElement data)
    {
        if (data.ValueKind == JsonValueKind.Array) return data.EnumerateArray();
        foreach (var name in new[] { "items", "rows", "data", "result" })
            if (data.Prop(name) is { ValueKind: JsonValueKind.Array } a) return a.EnumerateArray();
        throw new OptiCloudException(OptiCloudException.Unexpected);
    }
}
