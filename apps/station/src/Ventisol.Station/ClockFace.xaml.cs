using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace Ventisol.Station;

// Moves like a Swiss railway clock: the seconds hand sweeps round in 58.5 seconds, waits at 12,
// and the minute hand jumps when the minute is full. Redrawn 20 times a second (a third of a degree
// a step, which reads as a sweep), and only while it is loaded and on screen.
public partial class ClockFace : UserControl
{
    const double Sweep = 58.5;

    // One timer for the life of the face: starting it twice is still one tick.
    readonly DispatcherTimer _timer = new(DispatcherPriority.Render) { Interval = TimeSpan.FromMilliseconds(50) };

    public ClockFace()
    {
        InitializeComponent();
        DrawMarks();
        _timer.Tick += Ui.SafeTick(Draw);
        Loaded += (_, _) => Run();
        Unloaded += (_, _) => _timer.Stop();
        IsVisibleChanged += (_, _) => Run();
    }

    // Runs while the face is in a window and shown (not on a page or in a tile that is hidden).
    void Run()
    {
        if (IsLoaded && IsVisible)
        {
            Draw();
            _timer.Start();
        }
        else _timer.Stop();
    }

    // 60 marks, every fifth a thick hour bar. They go under the hands.
    void DrawMarks()
    {
        var ink = new SolidColorBrush(Color.FromRgb(0x07, 0x18, 0x18));
        ink.Freeze();
        for (var i = 0; i < 60; i++)
        {
            var hour = i % 5 == 0;
            var (width, length) = hour ? (12.0, 27.0) : (3.6, 10.0);
            var mark = new Rectangle
            {
                Width = width, Height = length, Fill = ink,
                RenderTransform = new RotateTransform(i * 6, width / 2, 100 - 4),
            };
            Canvas.SetLeft(mark, 100 - width / 2);
            Canvas.SetTop(mark, 4);
            Face.Children.Insert(0, mark);
        }
    }

    void Draw()
    {
        var now = DateTime.Now;
        var seconds = now.Second + now.Millisecond / 1000.0;
        SecondAngle.Angle = seconds < Sweep ? seconds / Sweep * 360 : 0;
        MinuteAngle.Angle = now.Minute * 6;
        HourAngle.Angle = (now.Hour % 12 + now.Minute / 60.0) * 30;
    }
}
