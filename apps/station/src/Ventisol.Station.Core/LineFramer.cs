using System.Text;

namespace Ventisol.Station.Core;

// Turns the text a serial port hands over, in whatever chunks it arrives, into whole lines.
// One per port. A line ends at CR, LF or CRLF; blank lines are dropped, so a CRLF split
// across two chunks is no different from one in a single chunk.
public sealed class LineFramer(int maxLength = 1024)
{
    readonly StringBuilder _pending = new();

    public IReadOnlyList<string> Push(string chunk)
    {
        List<string>? lines = null;
        foreach (var c in chunk)
        {
            if (c is '\r' or '\n')
            {
                var line = _pending.ToString().Trim();
                _pending.Clear();
                if (line.Length > 0) (lines ??= []).Add(line);
            }
            // A scanner that never sends a line end must not grow this forever.
            else if (_pending.Length < maxLength) _pending.Append(c);
        }
        return lines ?? (IReadOnlyList<string>)[];
    }
}
