using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace PDFy;

internal sealed partial class MainForm
{
    private static readonly Color HeaderColor = Color.FromArgb(0x20, 0x23, 0x25);
    private bool _customFrame = true;
    private bool _windowFocused;
    private bool _fullScreen;
    private Rectangle _boundsBeforeFull;
    private FormWindowState _stateBeforeFull;

    /// <summary>
    /// F11 in the page asks for full screen. The page alone can only fill the window, so the window
    /// itself covers the whole monitor, and goes back exactly as it was afterwards.
    /// </summary>
    private void SetFullScreen(bool on)
    {
        if (on == _fullScreen) return;
        try
        {
            _fullScreen = on;
            if (on)
            {
                _stateBeforeFull = WindowState;
                if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
                _boundsBeforeFull = Bounds;
                FormBorderStyle = FormBorderStyle.None;
                UpdateResizeStrip();
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = _boundsBeforeFull;
                WindowState = _stateBeforeFull;
                UpdateResizeStrip();
                RefreshNativeFrame();
            }
        }
        catch (Exception e)
        {
            Program.Log("Full screen: " + e.Message);
        }
    }
    private FormWindowState _reportedWindowState;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (!_customFrame) return;
        try
        {
            ExtendShadow();
            RefreshNativeFrame();
            UpdateResizeStrip();
        }
        catch (Exception ex) { UseStandardFrame(ex); }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateResizeStrip();
        if (_reportedWindowState == WindowState) return;
        _reportedWindowState = WindowState;
        SendWindowState();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        UpdateResizeStrip();
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        _windowFocused = true;
        SendWindowState();
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        _windowFocused = false;
        SendWindowState();
    }

    private void UpdateResizeStrip()
    {
        // WebView2's child HWND consumes hit tests. Leave four logical pixels owned by
        // the form at the top; the native side and bottom borders remain unchanged.
        var top = _customFrame && !_fullScreen && WindowState == FormWindowState.Normal
            ? Math.Max(1, (int)Math.Ceiling(4.0 * DeviceDpi / 96)) : 0;
        if (Padding.Top != top) Padding = new Padding(0, top, 0, 0);
    }

    protected override void WndProc(ref Message m)
    {
        if (!_customFrame)
        {
            base.WndProc(ref m);
            return;
        }

        var defaultHandled = false;
        try
        {
            switch (m.Msg)
            {
                case WmNcCalcSize:
                    // RECT is also the first member of NCCALCSIZE_PARAMS (wParam != 0).
                    var proposed = Marshal.PtrToStructure<NativeRect>(m.LParam);
                    base.WndProc(ref m);
                    defaultHandled = true;
                    var client = Marshal.PtrToStructure<NativeRect>(m.LParam);
                    // Keep Windows' per-monitor work-area/frame calculations. A maximised
                    // sizable window extends beyond the work area by its frame thickness;
                    // use the native bottom inset at the top instead of the caption height.
                    client.Top = IsZoomed(Handle)
                        ? proposed.Top + (proposed.Bottom - client.Bottom)
                        : proposed.Top;
                    Marshal.StructureToPtr(client, m.LParam, false);
                    m.Result = IntPtr.Zero;
                    return;

                case WmNcHitTest:
                    base.WndProc(ref m);
                    defaultHandled = true;
                    if (WindowState != FormWindowState.Normal) return;
                    if (!GetWindowRect(Handle, out var bounds)) throw new Win32Exception();
                    // Signed coordinates are essential on monitors left of/above the primary.
                    var x = (int)(short)(m.LParam.ToInt64() & 0xffff);
                    var y = (int)(short)((m.LParam.ToInt64() >> 16) & 0xffff);
                    if (y >= bounds.Top && y < bounds.Top + Padding.Top)
                    {
                        var corner = GetSystemMetricsForDpi(SmCxSizeFrame, (uint)DeviceDpi)
                            + GetSystemMetricsForDpi(SmCxPaddedBorder, (uint)DeviceDpi);
                        if (corner <= 0) throw new InvalidOperationException("No native resize metrics.");
                        m.Result = (IntPtr)(x < bounds.Left + corner * 2 ? HtTopLeft
                            : x >= bounds.Right - corner * 2 ? HtTopRight : HtTop);
                    }
                    return;

                case WmDwmCompositionChanged:
                    ExtendShadow();
                    break;
            }
        }
        catch (Exception e) { UseStandardFrame(e); }

        if (!defaultHandled) base.WndProc(ref m);
    }

    private void ExtendShadow()
    {
        var margins = new Margins { Top = 1 };
        Marshal.ThrowExceptionForHR(DwmExtendFrameIntoClientArea(Handle, ref margins));
    }

    private void RefreshNativeFrame()
    {
        if (!SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
            SwpNoSize | SwpNoMove | SwpNoZOrder | SwpNoActivate | SwpFrameChanged))
            throw new Win32Exception();
    }

    private void UseStandardFrame(Exception error)
    {
        Program.Log("Custom frame: " + error);
        if (!_customFrame) return;
        _customFrame = false;
        Padding = Padding.Empty;
        if (!IsHandleCreated || IsDisposed) return;
        try
        {
            // Defer frame recalculation if the failure occurred inside WM_NCCALCSIZE.
            BeginInvoke(() =>
            {
                if (IsDisposed || !IsHandleCreated) return;
                try
                {
                    var margins = new Margins();
                    Marshal.ThrowExceptionForHR(DwmExtendFrameIntoClientArea(Handle, ref margins));
                }
                catch (Exception e) { Program.Log("Restore frame shadow: " + e.Message); }
                try { RefreshNativeFrame(); }
                catch (Exception e) { Program.Log("Restore frame: " + e.Message); }
            });
        }
        catch (Exception e) { Program.Log("Restore frame: " + e.Message); }
    }

    private void HandleWindowAction(string? action)
    {
        switch (action)
        {
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize": WindowState = FormWindowState.Maximized; break;
            case "restore": WindowState = FormWindowState.Normal; break;
            case "toggle-maximize":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal : FormWindowState.Maximized;
                break;
            case "close": Close(); break; // FormClosing asks the page about unsaved work.
        }
    }

    private void OnWindowKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyData != (Keys.Alt | Keys.Space)) return;
        e.SuppressKeyPress = true;
        try
        {
            // WebView2 forwards accelerator keys here. Post asynchronously so opening
            // the native menu does not block the browser's accelerator callback.
            if (!PostMessageW(Handle, WmSysCommand, (IntPtr)ScKeyMenu, (IntPtr)' '))
                throw new Win32Exception();
        }
        catch (Exception error) { UseStandardFrame(error); }
    }

    private void SendWindowState()
    {
        if (!_pageReady) return;
        try
        {
            _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "win-state",
                maximized = WindowState == FormWindowState.Maximized,
                focused = _windowFocused,
            }));
        }
        catch (Exception e) { Program.Log("Window state: " + e.Message); }
    }

    private void SetWindowColor(string? color)
    {
        if (color is null || color.Length != 7 || color[0] != '#'
            || !int.TryParse(color.AsSpan(1), NumberStyles.AllowHexSpecifier,
                CultureInfo.InvariantCulture, out var rgb)) return;
        BackColor = Color.FromArgb((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        _web.DefaultBackgroundColor = BackColor;
    }

    // Keep FormBorderStyle.Sizable and its caption/system-menu/min/max styles. Only
    // WM_NCCALCSIZE changes their appearance; Windows still owns Snap and animations.
    // https://learn.microsoft.com/windows/win32/dwm/customframe
    private const int WmNcCalcSize = 0x0083, WmNcHitTest = 0x0084, WmDwmCompositionChanged = 0x031e;
    private const int WmSysCommand = 0x0112, ScKeyMenu = 0xf100;
    private const int HtTop = 12, HtTopLeft = 13, HtTopRight = 14;
    private const int SmCxSizeFrame = 32, SmCxPaddedBorder = 92;
    private const uint SwpNoSize = 0x0001, SwpNoMove = 0x0002, SwpNoZOrder = 0x0004,
        SwpNoActivate = 0x0010, SwpFrameChanged = 0x0020;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Margins { public int Left, Right, Top, Bottom; }

    [DllImport("dwmapi.dll", ExactSpelling = true)]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);

    [DllImport("user32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter,
        int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
}
