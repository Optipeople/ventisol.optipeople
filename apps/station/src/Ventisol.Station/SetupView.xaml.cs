using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// The setup screen as an overlay: put it last in the window's root grid, spanning every row, and call
// Open with a fresh SetupViewModel. It closes itself when the view model saves or cancels; what
// happens to the settings is up to whoever listens to the view model's Saved.
public partial class SetupView : UserControl
{
    const double MaxSheetWidth = 1180;

    public SetupView()
    {
        InitializeComponent();
        SizeChanged += (_, _) => Sheet.Width = Math.Min(MaxSheetWidth, ActualWidth);
    }

    public SetupViewModel? ViewModel { get; private set; }

    public bool IsOpen => ViewModel is not null;

    public void Open(SetupViewModel vm)
    {
        if (IsOpen) return;
        ViewModel = vm;
        vm.Saved += OnSaved;
        vm.Cancelled += OnCancelled;
        DataContext = vm;
        PasswordInput.Clear();
        UpdatePasswordHint();

        Visibility = Visibility.Visible;
        if (Motion.On)
        {
            var width = Math.Min(MaxSheetWidth, ActualWidth > 0 ? ActualWidth : MaxSheetWidth);
            SheetShift.BeginAnimation(TranslateTransform.XProperty,
                new DoubleAnimation(width, 0, Motion.Normal) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
            Scrim.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200)));
        }
        vm.Activate();
    }

    // Esc, or anything else that should leave without saving.
    public void Cancel() => ViewModel?.CancelCommand.Execute(null);

    void OnSaved(Ventisol.Station.Core.StationSettings _, string? __) => Close();

    void OnCancelled() => Close();

    void Close()
    {
        if (ViewModel is { } vm)
        {
            vm.Saved -= OnSaved;
            vm.Cancelled -= OnCancelled;
        }
        ViewModel = null;
        PasswordInput.Clear();
        Keyboard.ClearFocus();

        void Gone()
        {
            if (IsOpen) return; // opened again meanwhile
            Visibility = Visibility.Collapsed;
            DataContext = null;
        }

        if (!Motion.On) { Gone(); return; }
        var slide = new DoubleAnimation(0, Sheet.ActualWidth, TimeSpan.FromMilliseconds(200)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
        slide.Completed += (_, _) => Gone();
        SheetShift.BeginAnimation(TranslateTransform.XProperty, slide);
        Scrim.BeginAnimation(OpacityProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(200)));
    }

    void OnPasswordChanged(object sender, RoutedEventArgs e)
    {
        if (ViewModel is { } vm) vm.Password = PasswordInput.Password;
        UpdatePasswordHint();
    }

    void UpdatePasswordHint() =>
        PasswordHint.Visibility = PasswordInput.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;

    // A scanner in keyboard mode types its scan: make sure it doesn't land in a field.
    void OnIdentify(object sender, RoutedEventArgs e) => Keyboard.ClearFocus();

    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        base.OnPreviewKeyDown(e);
        if (e.Key == Key.Escape && IsOpen) { Cancel(); e.Handled = true; }
    }
}
