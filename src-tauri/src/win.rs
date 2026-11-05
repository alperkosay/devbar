// Windows'a özel yardımcılar. Diğer sistemlerde boş ya da Tauri karşılıkları.
use tauri::WebviewWindow;

#[cfg(windows)]
mod sys {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[repr(C)]
    pub struct AppBarData {
        pub cb_size: u32,
        pub hwnd: isize,
        pub callback: u32,
        pub edge: u32,
        pub rc: Rect,
        pub lparam: isize,
    }
    #[repr(C)]
    pub struct LastInput {
        pub cb_size: u32,
        pub time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> isize;
        pub fn GetWindowRect(hwnd: isize, rc: *mut Rect) -> i32;
        pub fn GetClassNameW(hwnd: isize, buf: *mut u16, len: i32) -> i32;
        pub fn GetLastInputInfo(info: *mut LastInput) -> i32;
        pub fn GetShellWindow() -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetTickCount() -> u32;
    }
    #[link(name = "shell32")]
    extern "system" {
        pub fn SHAppBarMessage(msg: u32, data: *mut AppBarData) -> usize;
    }
}

#[cfg(windows)]
fn hwnd(win: &WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}


/// Ekranın üstünde `height` fiziksel piksellik şeridi görev çubuğu gibi ayırır (AppBar).
/// Böylece ekranı kaplayan pencereler şeridin altından başlar.
pub fn appbar_set(win: &WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    #[cfg(windows)]
    {
        const ABM_NEW: u32 = 0;
        const ABM_QUERYPOS: u32 = 2;
        const ABM_SETPOS: u32 = 3;
        const ABE_TOP: u32 = 1;
        let Some(h) = hwnd(win) else { return };
        let mut d = sys::AppBarData {
            cb_size: std::mem::size_of::<sys::AppBarData>() as u32,
            hwnd: h,
            callback: 0x0400 + 77,
            edge: ABE_TOP,
            rc: sys::Rect { left: x, top: y, right: x + width, bottom: y + height },
            lparam: 0,
        };
        unsafe {
            sys::SHAppBarMessage(ABM_NEW, &mut d); // zaten kayıtlıysa sessizce başarısız olur
            sys::SHAppBarMessage(ABM_QUERYPOS, &mut d);
            d.rc.bottom = d.rc.top + height;
            sys::SHAppBarMessage(ABM_SETPOS, &mut d);
        }
    }
    #[cfg(not(windows))]
    let _ = (win, x, y, width, height);
}

pub fn appbar_remove(win: &WebviewWindow) {
    #[cfg(windows)]
    {
        const ABM_REMOVE: u32 = 1;
        let Some(h) = hwnd(win) else { return };
        let mut d = sys::AppBarData {
            cb_size: std::mem::size_of::<sys::AppBarData>() as u32,
            hwnd: h,
            callback: 0,
            edge: 0,
            rc: Default::default(),
            lparam: 0,
        };
        unsafe {
            sys::SHAppBarMessage(ABM_REMOVE, &mut d);
        }
    }
    #[cfg(not(windows))]
    let _ = win;
}

/// Öndeki pencere (masaüstü değilse) monitörü tamamen kaplıyor mu: video, oyun, sunum.
pub fn fullscreen_app(own: &WebviewWindow, mon: (i32, i32, i32, i32)) -> bool {
    #[cfg(windows)]
    unsafe {
        let fg = sys::GetForegroundWindow();
        if fg == 0 || Some(fg) == hwnd(own) || fg == sys::GetShellWindow() {
            return false;
        }
        let mut name = [0u16; 64];
        let n = sys::GetClassNameW(fg, name.as_mut_ptr(), 64).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..n]);
        if class == "WorkerW" || class == "Progman" {
            return false;
        }
        let mut r = sys::Rect::default();
        if sys::GetWindowRect(fg, &mut r) == 0 {
            return false;
        }
        let (x, y, w, h) = mon;
        r.left <= x && r.top <= y && r.right >= x + w && r.bottom >= y + h
    }
    #[cfg(not(windows))]
    {
        let _ = (own, mon);
        false
    }
}

/// Pencereyi odağı çalmadan gösterir ya da gizler.
pub fn set_visible(win: &WebviewWindow, visible: bool) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        }
        const SW_HIDE: i32 = 0;
        const SW_SHOWNOACTIVATE: i32 = 4;
        if let Some(h) = hwnd(win) {
            unsafe {
                ShowWindow(h, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = if visible { win.show() } else { win.hide() };
    }
}

/// Son klavye/fare hareketinden bu yana geçen saniye.
pub fn idle_seconds() -> u64 {
    #[cfg(windows)]
    unsafe {
        let mut info = sys::LastInput { cb_size: std::mem::size_of::<sys::LastInput>() as u32, time: 0 };
        if sys::GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        (sys::GetTickCount().wrapping_sub(info.time) / 1000) as u64
    }
    #[cfg(not(windows))]
    0
}
