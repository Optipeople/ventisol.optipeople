using System.Globalization;
using System.Windows;
using System.Windows.Markup;

namespace Ventisol.Station;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Danish dates and times everywhere, whatever the PC is set to.
        var da = CultureInfo.GetCultureInfo("da-DK");
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.DefaultThreadCurrentUICulture = da;
        Thread.CurrentThread.CurrentCulture = Thread.CurrentThread.CurrentUICulture = da;
        FrameworkElement.LanguageProperty.OverrideMetadata(typeof(FrameworkElement),
            new FrameworkPropertyMetadata(XmlLanguage.GetLanguage(da.IetfLanguageTag)));

        // --kiosk on the shop floor PC: full screen, no window buttons.
        var kiosk = e.Args.Contains("--kiosk", StringComparer.OrdinalIgnoreCase);
        // --showcase starts with sample scans on the screen.
        var showcase = e.Args.Contains("--showcase", StringComparer.OrdinalIgnoreCase);
        new MainWindow(kiosk, showcase).Show();
    }
}
