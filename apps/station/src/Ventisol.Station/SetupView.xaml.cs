using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// The setup screen as an overlay: put it late in the window's root grid, spanning every row, and call
// Open with a fresh SetupViewModel. It closes itself when the view model has saved or cancels; a save
// that could not be written leaves it open (the view model says why). What happens to the settings
// is up to whoever gave the view model its Persist and listens to its Saved.
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
        // A fresh screen starts at the top, not where the last one was left.
        Scroller.ScrollToTop();

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
        FocusWindow();

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

    // The PIN is digits only.
    void OnPinTextInput(object sender, TextCompositionEventArgs e) =>
        e.Handled = !e.Text.All(c => c is >= '0' and <= '9');

    // A text field takes the mouse wheel for itself (it has a scroller of its own, with nothing to
    // scroll), so with the pointer over one the screen stood still. Scroll the screen from here.
    void OnScrollerWheel(object sender, MouseWheelEventArgs e)
    {
        if (e.OriginalSource is not DependencyObject d || !InField(d)) return;
        // One step, as a scroller moves of its own accord for each turn of the wheel.
        Scroller.ScrollToVerticalOffset(Scroller.VerticalOffset + (e.Delta < 0 ? 48 : -48));
        e.Handled = true;
    }

    static bool InField(DependencyObject d)
    {
        for (var x = d; x is not null; x = x is Visual ? VisualTreeHelper.GetParent(x) : LogicalTreeHelper.GetParent(x))
            if (x is System.Windows.Controls.Primitives.TextBoxBase or PasswordBox) return true;
        return false;
    }

    // A scanner in keyboard mode types its scan: make sure it doesn't land in a field.
    void OnIdentify(object sender, RoutedEventArgs e) => FocusWindow();

    // Out of any field, onto the window. Not Keyboard.ClearFocus: with nothing focused WPF raises no
    // key events at all, so a keyboard-mode scanner went unheard (in Identificér, and at the stations
    // after the setup closed) until someone clicked the window.
    void FocusWindow()
    {
        if (Window.GetWindow(this) is { } w) Keyboard.Focus(w);
        else Keyboard.ClearFocus();
    }

    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        base.OnPreviewKeyDown(e);
        if (e.Key == Key.Escape && IsOpen && !Ui.IsDropDownOpen()) { Cancel(); e.Handled = true; }
    }
}
