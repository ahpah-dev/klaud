---
name: computer-use
description: Operate the Windows desktop itself - screenshot the screen, list open windows, focus a window by title, move and click the mouse, type text and press keys - using run_command with PowerShell. Use only when the user explicitly asks for something that needs the GUI, such as clicking a button in an app that has no command line.
when_to_use: take a screenshot, screenshot my screen, click in an app, type into a window, automate a GUI app, focus a window, what windows are open
---

Klaud has no desktop tools. Everything here is `run_command` with PowerShell, acting on the same desktop the user is sitting at, with the user's full permissions and the user watching.

**This is the most damaging skill Klaud has, and there is no undo.** Read this before the first click:

- A click goes to whatever window is at those pixels. It can buy, send, post, delete, close or confirm something without a confirmation prompt.
- A keystroke goes to whichever control has keyboard focus, and that is not always the control that looks selected.
- Coordinates are pixels. A window that moved, a maximised window on top, a different monitor or a different DPI setting all move the target, and the click then lands somewhere else.
- Use it only when the user asked for something that genuinely needs the GUI. If the program has a command line, or the task is a file edit or a web page, use `run_command`, the file tools or the browser tools instead.

Everything below was run on this machine; the limits are stated at the end.

## One command does everything

Each `run_command` is a new process, so the helper type does not survive into the next call. Define it and use it in the **same** command. A second command that starts with `[KlaudDesktop]::` fails with "unable to find type", which is not a sign the desktop cannot be driven.

## The helper type

Paste this block at the top of the command that needs it. The `if` guard makes it safe to paste twice in one command.

```powershell
if (-not ('KlaudDesktop' -as [type])) {
  $code = @'
using System;
using System.Runtime.InteropServices;

public class KlaudDesktop
{
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  // INPUT is a union, and Windows rejects the call if sizeof(INPUT) is wrong, so
  // MOUSEINPUT has to be declared even though only the keyboard side is used.
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT Key(ushort vk, ushort scan, uint flags)
  {
    INPUT i = new INPUT();
    i.type = 1;
    i.U.ki.wVk = vk;
    i.U.ki.wScan = scan;
    i.U.ki.dwFlags = flags;
    return i;
  }

  // SetForegroundWindow is refused for a process that does not already own the
  // foreground, and it says so with a plain false. Windows lets the process that
  // handled the last input event take the foreground, so a bare ALT tap first
  // makes the hand-over legal. The answer is read back from GetForegroundWindow,
  // because "the call returned true" is not the same as "that window is in front".
  public static bool Focus(string title)
  {
    IntPtr h = FindWindow(null, title);
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
    ShowWindow(h, 5);                    // SW_SHOW
    PressKey(0x12);                      // ALT tap, so the hand-over is allowed
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }

  // Move, settle, press, release. The settle is what lets a control that appears
  // on hover be the thing the press lands on.
  public static bool Click(int x, int y)
  {
    bool moved = SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);   // LEFTDOWN
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);   // LEFTUP
    return moved;
  }

  // One SendInput per character, sent as Unicode, so layout, shift state and
  // punctuation in the text cannot be reinterpreted as shortcuts.
  public static uint TypeText(string text)
  {
    INPUT[] list = new INPUT[text.Length * 2];
    for (int n = 0; n < text.Length; n++)
    {
      ushort c = text[n];
      list[n * 2] = Key(0, c, KEYEVENTF_UNICODE);
      list[n * 2 + 1] = Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }
    return SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
  }

  // A virtual-key press and release: 0x0D Enter, 0x09 Tab, 0x08 Backspace,
  // 0x1B Escape, 0x25-0x28 arrows, 0x2E Delete.
  public static uint PressKey(ushort vk)
  {
    INPUT[] list = new INPUT[2];
    list[0] = Key(vk, 0, 0);
    list[1] = Key(vk, 0, KEYEVENTF_KEYUP);
    return SendInput(2, list, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
  Add-Type -TypeDefinition $code
}
```

`Add-Type` compiles on first use (a few hundred milliseconds), which is why it belongs in the command that acts rather than in a command of its own.

## Screenshot

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bmp.Size)
$file = Join-Path $env:TEMP 'screen.png'
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$file
```

You cannot see the image, so it is evidence for the user, not for you. Do not take one to "look" at a window: you cannot read it. Take one when the user asked for it, or to confirm something rendered when they asked you to check.

## List open windows

```powershell
Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle
```

`Focus` matches the title exactly, so read the exact string from this list rather than guessing at it.

## Focus a window by title

```powershell
[KlaudDesktop]::Focus('Untitled - Notepad')
```

`True` means that window was the foreground window when the call returned; `False` means it was not found, or Windows refused to move focus. A window can lose the foreground again a moment later, so treat this as "raised and restored", then click the control you actually want before typing. On `False`, stop: anything you type next goes to whatever is in front.

## Move and click

```powershell
[KlaudDesktop]::Click(1200, 400)
```

Left click at screen coordinates. It returns whether the cursor moved, not whether the click did anything, so confirm the effect from the app itself. For a right or middle click, replace the two flags 0x0002 and 0x0004 with 0x0008 and 0x0010, which was not verified here.

## Type text

```powershell
[KlaudDesktop]::TypeText('Hello from Klaud, 42 + 8 = 50.')
```

Any text, any punctuation. The return value is the number of input events; 0 means nothing was delivered. Click the field first: a window being in front does not mean the right field has focus.

## Press keys

```powershell
[KlaudDesktop]::PressKey(0x0D)
```

Enter, as a full press and release. A shortcut that holds a modifier down (Ctrl+S, Alt+Tab) is **not** expressible with this helper, and a half-invented combination is how a window gets its menu opened or a file closed by accident. Say a shortcut is not supported rather than guessing at one.

## Verify, do not assume

- Read the boolean from `Focus` and the count from `TypeText`. A refused focus or a zero count is the cheapest signal you will get that nothing happened.
- `True` from `Focus` means Windows calls that window the foreground window. It is not a promise that the app will accept what you send, so confirm the effect rather than the return value.
- After a click or a keystroke, confirm the outcome where the outcome is visible: the app's own saved file with `read_file`, or a screenshot for the user. An app that ignored the input looks exactly like one that took it.
- If a click did nothing, the target window was probably behind another one. `Focus` it, check the boolean, and try once more, rather than clicking repeatedly at the same pixel.

## What was and was not verified

Verified by running it: Windows 10 Pro 10.0.19045, Windows PowerShell 5.1, one 2560x1440 monitor at 100% scaling, unelevated.

- Verified: the helper block compiles; a full-screen PNG is written; the window list finds a window by title; `Focus` restores a minimised window and raises one that was behind another app; `Click` fires a real button's click event; `TypeText` puts text including spaces and punctuation into a text field; `PressKey` Enter, Tab (moves focus) and Backspace (deletes a character) all take effect.
- Watched and worth knowing: `Focus` can return `True` and the window can still lose the foreground a moment later. A real click on the control afterwards still worked, and typing then arrived, so click before you type rather than trusting the boolean alone.
- Not verified, so do not imply otherwise: right and middle clicks, modifier combinations, DPI scaling other than 100%, multiple monitors or negative coordinates, a target app that runs elevated (Windows blocks synthetic input into a higher-integrity window), an app that ignores synthetic input by design, a shell started without a console (in the rig used to write this, `Focus`, the window list and the screenshot worked there but clicks and keystrokes did not reach the target), and any part of this outside Windows.

Windows only. `user32.dll` does not exist on macOS or Linux, so none of this carries over there. The equivalents are `screencapture` and `osascript` on macOS and `xdotool` or `import` on X11; none of them was tested here. If the user is not on Windows, say the desktop cannot be driven on their platform yet rather than shipping an untested guess.
