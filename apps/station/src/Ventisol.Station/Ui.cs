using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
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

    // While a dropdown is open, focus is on its box or on one of its items (in the popup).
    // Esc then belongs to the dropdown, not to whatever the window would close with it.
    public static bool IsDropDownOpen() =>
        Keyboard.FocusedElement is DependencyObject f
        && (f as ComboBox ?? ItemsControl.ItemsControlFromItemContainer(f) as ComboBox) is { IsDropDownOpen: true };

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
