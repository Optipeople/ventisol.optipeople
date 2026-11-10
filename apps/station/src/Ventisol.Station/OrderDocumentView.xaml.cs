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
                Dispatcher.BeginInvoke(DispatcherPriority.Loaded, ScrollToStartPage);
                break;
        }
    }

    void ScrollToStartPage()
    {
        if (_vm is null) return;
        PagesScroller.UpdateLayout();
        if (PagesList.ItemContainerGenerator.ContainerFromIndex(_vm.StartPage) is FrameworkElement page)
            PagesScroller.ScrollToVerticalOffset(page.TranslatePoint(new Point(), PagesList).Y);
        else
            PagesScroller.ScrollToTop();
    }
}
