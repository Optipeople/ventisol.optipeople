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

    // A window with no title bar maximizes over the whole screen, a little past its edges, and the
    // taskbar then lies over its bottom edge (the setup's "Gem", the logo, the page dots). Told the
    // work area as its maximized size, it stops at the taskbar. For a window outside kiosk mode;
    // call it once the window has its handle.
    public static void MaximizeToWorkArea(Window w)
    {
        try { HwndSource.FromHwnd(new WindowInteropHelper(w).Handle)?.AddHook(WorkAreaHook); }
        catch { }
    }

    static IntPtr WorkAreaHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_GETMINMAXINFO = 0x0024, MONITOR_DEFAULTTONEAREST = 2;
        if (msg != WM_GETMINMAXINFO) return IntPtr.Zero;
        try
        {
            var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
            if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return IntPtr.Zero;
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
            // Relative to the monitor the window is on.
            mmi.MaxPosition = new POINT { X = info.Work.Left - info.Monitor.Left, Y = info.Work.Top - info.Monitor.Top };
            mmi.MaxSize = new POINT { X = info.Work.Right - info.Work.Left, Y = info.Work.Bottom - info.Work.Top };
            Marshal.StructureToPtr(mmi, lParam, false);
        }
        catch { }
        return IntPtr.Zero;
    }

    // While a dropdown is open, focus is on its box or on one of its items (in the popup).
    // Esc then belongs to the dropdown, not to whatever the window would close with it.
    public static bool IsDropDownOpen() =>
        Keyboard.FocusedElement is DependencyObject f
        && (f as ComboBox ?? ItemsControl.ItemsControlFromItemContainer(f) as ComboBox) is { IsDropDownOpen: true };

    // A DispatcherTimer does not start again after its Tick handler throws, and the app logs an error
    // and carries on (App), so one error would stop a clock for good in an app that looks healthy.
    // Wrapped like this the timer keeps running. A handler that fails over and over is logged in full
    // once a minute and in one line in between, so it can't fill the disk, and only the ones logged
    // in full count toward the three errors in a minute that restart the app (App): a clock that
    // can't be drawn must not take the scans down with it. Another error than the last one logged in
    // full (its type or its message) is a new one: in full, and counted.
    public static EventHandler SafeTick(Action tick)
    {
        var inFull = DateTimeOffset.MinValue;
        string? last = null;
        return (_, _) =>
        {
            try { tick(); }
            catch (Exception ex)
            {
                var now = DateTimeOffset.Now;
                // By kind and place, not by message: a message with a number in it differs every tick.
                var what = $"{ex.GetType().FullName} in {ex.TargetSite?.DeclaringType?.FullName}.{ex.TargetSite?.Name}";
                var brief = what == last && now - inFull < TimeSpan.FromMinutes(1);
                if (!brief) { inFull = now; last = what; }
                App.NoteError(ex, brief);
            }
        };
    }

    // Whether the window is the one in front, as Windows sees it. A window can be the active one of
    // its own app (IsActive) while another program has the foreground and the keyboard.
    public static bool IsInFront(Window w)
    {
        try
        {
            var hwnd = new WindowInteropHelper(w).Handle;
            return hwnd != IntPtr.Zero && GetForegroundWindow() == hwnd;
        }
        catch { return false; }
    }

    // Whether the window in front is Windows' own: the taskbar, the Start menu, the tray's overflow,
    // the desktop. Someone there may be on their way to the app's tray icon.
    public static bool ShellIsInFront()
    {
        try
        {
            GetWindowThreadProcessId(GetForegroundWindow(), out var pid);
            if (pid == 0) return false;
            using var process = System.Diagnostics.Process.GetProcessById((int)pid);
            return process.ProcessName.ToLowerInvariant() is "explorer" or "startmenuexperiencehost" or "searchhost" or "searchapp" or "shellexperiencehost";
        }
        catch { return false; }
    }

    // Puts the window in front and gives it the keyboard. Windows only lets the app in front hand the
    // foreground on, so for the moment it takes, this thread shares its input with that app's.
    // Not with a program that hangs: this thread would hang with it.
    public static void TakeForeground(Window w)
    {
        try
        {
            var hwnd = new WindowInteropHelper(w).Handle;
            var front = GetForegroundWindow();
            var theirs = IsHungAppWindow(front) ? 0 : GetWindowThreadProcessId(front, out _);
            var ours = GetCurrentThreadId();
            var attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true);
            try { SetForegroundWindow(hwnd); }
            finally { if (attached) AttachThreadInput(ours, theirs, false); }
            w.Activate();
        }
        catch { }
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool IsHungAppWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint attach, uint to, bool on);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO { public POINT Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int Size; public RECT Monitor, Work; public int Flags; }
}
