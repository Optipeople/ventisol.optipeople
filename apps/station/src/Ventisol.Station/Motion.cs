using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Ventisol.Station;

// The app's motion, kept in one place so it feels the same everywhere: short, eased out, no bounce.
// Off when Windows has animations turned off.
static class Motion
{
    public static bool On => SystemParameters.ClientAreaAnimation;

    public static readonly TimeSpan Fast = TimeSpan.FromMilliseconds(160);
    public static readonly TimeSpan Normal = TimeSpan.FromMilliseconds(260);

    static readonly IEasingFunction Out = Freeze(new CubicEase { EasingMode = EasingMode.EaseOut });
    static readonly IEasingFunction In = Freeze(new CubicEase { EasingMode = EasingMode.EaseIn });

    static IEasingFunction Freeze(EasingFunctionBase e) { e.Freeze(); return e; }

    // The element's own translate, created if it has none, so moves never share or hit a frozen one.
    public static TranslateTransform Shift(UIElement e)
    {
        if (e.RenderTransform is TranslateTransform { IsFrozen: false } t) return t;
        t = new TranslateTransform();
        e.RenderTransform = t;
        return t;
    }

    // Fade and slide in from an offset to where it belongs. A delay holds it at the start
    // (invisible, offset) until its turn, so staggered elements never flash in early.
    public static void Enter(UIElement e, double fromX = 0, double fromY = 0, TimeSpan? delay = null, TimeSpan? duration = null)
    {
        if (!On) { e.Opacity = 1; return; }
        var d = duration ?? Normal;
        var wait = delay ?? TimeSpan.Zero;
        e.Opacity = 1;
        e.BeginAnimation(UIElement.OpacityProperty, From(0, 1, wait, d));
        // The slide ends at rest and lets go: the value underneath is set to 0 first, so when the
        // animation stops nothing jumps, and a later set of X or Y (a drag in "Tilpas layout") takes.
        var t = Shift(e);
        if (fromX != 0) { t.X = 0; t.BeginAnimation(TranslateTransform.XProperty, From(fromX, 0, wait, d)); }
        if (fromY != 0) { t.Y = 0; t.BeginAnimation(TranslateTransform.YProperty, From(fromY, 0, wait, d)); }
    }

    // Never held at its end: a held animation would override every value set on the property after it.
    static AnimationTimeline From(double from, double to, TimeSpan wait, TimeSpan d)
    {
        var a = new DoubleAnimationUsingKeyFrames { FillBehavior = FillBehavior.Stop };
        a.KeyFrames.Add(new DiscreteDoubleKeyFrame(from, KeyTime.FromTimeSpan(TimeSpan.Zero)));
        if (wait > TimeSpan.Zero) a.KeyFrames.Add(new DiscreteDoubleKeyFrame(from, KeyTime.FromTimeSpan(wait)));
        a.KeyFrames.Add(new EasingDoubleKeyFrame(to, KeyTime.FromTimeSpan(wait + d), Out));
        return a;
    }

    // Fade and slide out by an offset, then run done (to collapse or remove it).
    public static void Leave(UIElement e, double toX = 0, double toY = 0, Action? done = null)
    {
        if (!On) { done?.Invoke(); return; }
        var fade = new DoubleAnimation(0, Fast) { EasingFunction = In };
        fade.Completed += (_, _) => done?.Invoke();
        e.BeginAnimation(UIElement.OpacityProperty, fade);
        var t = Shift(e);
        if (toX != 0) t.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(0, toX, Fast) { EasingFunction = In });
        if (toY != 0) t.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0, toY, Fast) { EasingFunction = In });
    }

    // Glide from an offset back to rest. Used when a block has already moved in the layout,
    // so it travels from where it was instead of jumping. The rest value (0) is set underneath and
    // the animation lets go when it ends, so the next drag's own X and Y are not overridden.
    public static void Glide(TranslateTransform t, Vector from)
    {
        t.BeginAnimation(TranslateTransform.XProperty, null);
        t.BeginAnimation(TranslateTransform.YProperty, null);
        (t.X, t.Y) = (0, 0);
        if (!On || from.Length < 1) return;
        t.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(from.X, 0, Normal) { EasingFunction = Out, FillBehavior = FillBehavior.Stop });
        t.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(from.Y, 0, Normal) { EasingFunction = Out, FillBehavior = FillBehavior.Stop });
    }

    public static void FadeIn(UIElement e, TimeSpan? duration = null)
    {
        if (!On) return;
        e.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, duration ?? Fast) { EasingFunction = Out, FillBehavior = FillBehavior.Stop });
    }

    // A small grow into place, for something that just changed state.
    public static void Pop(UIElement e, double from = 0.6)
    {
        if (!On) return;
        var s = new ScaleTransform();
        e.RenderTransformOrigin = new Point(0.5, 0.5);
        e.RenderTransform = s;
        var a = new DoubleAnimation(from, 1, Normal) { EasingFunction = Out };
        s.BeginAnimation(ScaleTransform.ScaleXProperty, a);
        s.BeginAnimation(ScaleTransform.ScaleYProperty, a);
    }
}
