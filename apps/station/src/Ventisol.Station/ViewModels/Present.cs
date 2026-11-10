using System.Collections;
using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace Ventisol.Station.ViewModels;

// Visible when the value is there: not null, not false, not an empty text or list.
public sealed class Present : IValueConverter
{
    public static Present Instance { get; } = new();

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        null or false => Visibility.Collapsed,
        string s => s.Length > 0 ? Visibility.Visible : Visibility.Collapsed,
        ICollection c => c.Count > 0 ? Visibility.Visible : Visibility.Collapsed,
        _ => Visibility.Visible,
    };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}
