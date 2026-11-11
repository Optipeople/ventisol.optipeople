using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// The element's document (see OrderDocumentView.xaml). Actions is put at the right of the header,
// for whoever hosts it: the overlay puts its close button there.
public partial class OrderDocumentView : UserControl
{
    public static readonly DependencyProperty ActionsProperty =
        DependencyProperty.Register(nameof(Actions), typeof(object), typeof(OrderDocumentView));

    OrderDocumentViewModel? _vm;
    // False from the pages opening until they are scrolled to the start page, so the top pages,
    // which are on screen for a moment before that, are not drawn for nothing.
    bool _pagesPlaced;

    public OrderDocumentView()
    {
        InitializeComponent();
        DataContextChanged += (_, e) =>
        {
            if (_vm is not null) _vm.PropertyChanged -= OnChanged;
            _vm = e.NewValue as OrderDocumentViewModel;
            if (_vm is not null) _vm.PropertyChanged += OnChanged;
        };
    }

    public object? Actions
    {
        get => GetValue(ActionsProperty);
        set => SetValue(ActionsProperty, value);
    }

    void OnChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            // A new element starts at the top of its facts.
            case nameof(OrderDocumentViewModel.Sheet):
                FactsScroller.ScrollToTop();
                break;
            // The pages open at the position's page, once they are laid out.
            case nameof(OrderDocumentViewModel.ShowingPages) when _vm!.ShowingPages:
                _pagesPlaced = false;
                Dispatcher.BeginInvoke(DispatcherPriority.Loaded, ScrollToStartPage);
                break;
        }
    }

    void ScrollToStartPage()
    {
        if (_vm is null) return;
        PagesScroller.UpdateLayout();
        var target = PagesList.ItemContainerGenerator.ContainerFromIndex(_vm.StartPage) is FrameworkElement page
            ? page.TranslatePoint(new Point(), PagesList).Y
            : 0;
        PagesScroller.ScrollToVerticalOffset(target);
        PagesScroller.UpdateLayout();
        _pagesPlaced = true;
        // A scroll that moves nothing raises no ScrollChanged, so say what is on screen here.
        // One that is still on its way reports when it lands.
        if (Math.Abs(PagesScroller.VerticalOffset - target) < 1) ReportPagesInView();
    }

    void OnPagesScrolled(object sender, ScrollChangedEventArgs e) => ReportPagesInView();

    // Tells the view model which pages are on screen, so it draws those and lets the others go.
    void ReportPagesInView()
    {
        if (!_pagesPlaced || _vm is not { ShowingPages: true } vm || PagesScroller.ViewportHeight <= 0) return;
        double top = PagesScroller.VerticalOffset, bottom = top + PagesScroller.ViewportHeight;
        int first = -1, last = -1;
        for (var i = 0; i < PagesList.Items.Count; i++)
        {
            if (PagesList.ItemContainerGenerator.ContainerFromIndex(i) is not FrameworkElement page) continue;
            var y = page.TranslatePoint(new Point(), PagesList).Y;
            if (y + page.ActualHeight <= top) continue;
            if (y >= bottom) break;
            if (first < 0) first = i;
            last = i;
        }
        if (first >= 0) vm.PagesInView(first, last);
    }
}
