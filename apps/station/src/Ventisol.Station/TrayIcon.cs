using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Ventisol.Station.ViewModels;
using Forms = System.Windows.Forms;

namespace Ventisol.Station;

// The app's icon in the notification area. It says which version runs and how OptiCloud is doing,
// and it reaches the window when it is behind something, minimized or off screen, also on a
// kiosk PC with no window buttons. Disposed on exit, or Windows leaves a dead icon until hovered.
sealed class TrayIcon : IDisposable
{
    // Windows cuts a tray tooltip at 127 characters.
    const int MaxTip = 127;

    readonly Forms.NotifyIcon _icon;
    readonly Window _window;
    readonly MainViewModel _vm;

    public TrayIcon(Window window, MainViewModel vm)
    {
        _window = window;
        _vm = vm;

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Vis skærmen", null, Safe("show", ShowWindow));
        menu.Items.Add("Åbn log", null, Safe("open log", OpenLogs));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Genstart", null, Safe("restart", () => { Log.Write("Restart from the tray"); App.Restart(); }));
        // Kept apart from Genstart and asked about, so a slip of the mouse doesn't stop the scans.
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Luk", null, Safe("close", Close));
        // The first item is what a double click does: show it in bold.
        menu.Items[0].Font = new System.Drawing.Font(menu.Items[0].Font, System.Drawing.FontStyle.Bold);

        _icon = new Forms.NotifyIcon { Icon = LoadIcon(), ContextMenuStrip = menu };
        var show = Safe("show", ShowWindow);
        _icon.MouseDoubleClick += (s, e) => { if (e.Button == Forms.MouseButtons.Left) show(s, e); };
        _vm.PropertyChanged += OnChanged;
        UpdateTip();
        _icon.Visible = true;
    }

    void OnChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.CloudText)) UpdateTip();
    }

    void UpdateTip()
    {
        var tip = $"Ventisol station {_vm.Version}\nOptiCloud: {_vm.CloudText}";
        _icon.Text = tip.Length > MaxTip ? tip[..MaxTip] : tip;
    }

    void ShowWindow()
    {
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Show();
        _window.Activate();
    }

    void Close()
    {
        if (MessageBox.Show(_window, "Luk MES-skærmen? Scanninger modtages ikke, før den startes igen.", "Luk",
                MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel) != MessageBoxResult.OK) return;
        Log.Write("Closed from the tray");
        Application.Current.Shutdown();
    }

    // WinForms shows an error dialog for an exception in a tray click, and on a kiosk PC nobody
    // is there to close it: log it and carry on instead.
    static EventHandler Safe(string what, Action action) => (_, _) =>
    {
        try { action(); }
        catch (Exception ex) { Log.Write($"Tray {what} failed: {ex}"); }
    };

    static void OpenLogs()
    {
        try
        {
            var folder = Path.Combine(AppPaths.Data, "logs");
            Directory.CreateDirectory(folder);
            Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
        }
        catch (Exception ex) { Log.Write($"Could not open the log folder: {ex.Message}"); }
    }

    // The app's own icon at the size the tray wants, falling back to the exe's.
    static System.Drawing.Icon LoadIcon()
    {
        try
        {
            using var stream = Application.GetResourceStream(new Uri("pack://application:,,,/Assets/app.ico")).Stream;
            return new System.Drawing.Icon(stream, Forms.SystemInformation.SmallIconSize);
        }
        catch
        {
            return System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? System.Drawing.SystemIcons.Application;
        }
    }

    public void Dispose()
    {
        _vm.PropertyChanged -= OnChanged;
        _icon.Visible = false;
        _icon.ContextMenuStrip?.Dispose();
        _icon.Dispose();
    }
}
