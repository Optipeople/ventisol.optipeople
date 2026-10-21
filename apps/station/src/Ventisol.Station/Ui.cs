using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Ventisol.Station;

static class Ui
{
    // Windows 11 rounds the corners of normal windows, but not always when the
    // title bar is custom. Ask for it explicitly. Ignored on Windows 10.
    public static void RoundCorners(Window w)
    {
        try
        {
            var hwnd = new WindowInteropHelper(w).Handle;
            int round = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int)); // DWMWA_WINDOW_CORNER_PREFERENCE
        }
        catch { }
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
