const std = @import("std");
const builtin = @import("builtin");

const HANDLE = *anyopaque;

const SETUP_VERSION = "0.1.0";
const SANDBOX_DIR_NAME = "windows-sandbox";
const MARKER_FILE_NAME = "setup.marker.json";

// Token elevation info class
const TokenElevation: u32 = 20;

// ShellExecuteExW
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x00000040;
const SW_HIDE: i32 = 0;

const SHELLEXECUTEINFOW = extern struct {
    cbSize: u32,
    fMask: u32,
    hwnd: ?*anyopaque,
    lpVerb: ?[*:0]const u16,
    lpFile: ?[*:0]const u16,
    lpParameters: ?[*:0]const u16,
    lpDirectory: ?[*:0]const u16,
    nShow: i32,
    hInstApp: ?*anyopaque,
    lpIDList: ?*anyopaque,
    lpClass: ?[*:0]const u16,
    hKeyClass: ?*anyopaque,
    dwHotKey: u32,
    hIconOrMonitor: ?*anyopaque,
    hProcess: ?*anyopaque,
};

extern "advapi32" fn OpenProcessToken(
    ProcessHandle: HANDLE,
    DesiredAccess: u32,
    TokenHandle: *HANDLE,
) callconv(.winapi) i32;

extern "advapi32" fn GetTokenInformation(
    TokenHandle: HANDLE,
    TokenInformationClass: u32,
    TokenInformation: ?*anyopaque,
    TokenInformationLength: u32,
    ReturnLength: *u32,
) callconv(.winapi) i32;

extern "shell32" fn ShellExecuteExW(pExecInfo: *SHELLEXECUTEINFOW) callconv(.winapi) i32;

extern "kernel32" fn GetCurrentProcess() callconv(.winapi) HANDLE;
extern "kernel32" fn GetModuleFileNameW(
    hModule: ?*anyopaque,
    lpFilename: [*]u16,
    nSize: u32,
) callconv(.winapi) u32;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) i32;
extern "kernel32" fn GetLastError() callconv(.winapi) u32;
extern "kernel32" fn CreateDirectoryW(lpPathName: [*:0]const u16, lpSecurityAttributes: ?*anyopaque) callconv(.winapi) i32;
extern "kernel32" fn GetStdHandle(nStdHandle: u32) callconv(.winapi) HANDLE;
extern "kernel32" fn WriteFile(
    hFile: HANDLE,
    lpBuffer: [*]const u8,
    nNumberOfBytesToWrite: u32,
    lpNumberOfBytesWritten: *u32,
    lpOverlapped: ?*anyopaque,
) callconv(.winapi) i32;

const TOKEN_QUERY: u32 = 0x0008;
const STD_ERROR_HANDLE: u32 = 0xFFFFFFF4;

fn printToErr(msg: []const u8) void {
    var written: u32 = 0;
    const h = GetStdHandle(STD_ERROR_HANDLE);
    _ = WriteFile(h, msg.ptr, @intCast(msg.len), &written, null);
}

fn isElevated() bool {
    var token: HANDLE = undefined;
    const ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
    if (ok == 0) return false;
    defer _ = CloseHandle(token);
    var elevation: u32 = 0;
    var ret_len: u32 = 0;
    const q = GetTokenInformation(token, TokenElevation, &elevation, @sizeOf(u32), &ret_len);
    if (q == 0) return false;
    return elevation != 0;
}

/// Get the current exe path as UTF-16.
fn getExePath(allocator: std.mem.Allocator) ![:0]u16 {
    var buf = try allocator.allocSentinel(u16, 4096, 0);
    const n = GetModuleFileNameW(null, buf.ptr, @intCast(buf.len - 1));
    if (n == 0) return error.GetModuleFileNameFailed;
    buf[n] = 0;
    return buf[0..n :0];
}

/// Convert ASCII string to NUL-terminated UTF-16.
fn toUtf16(allocator: std.mem.Allocator, s: []const u8) ![:0]u16 {
    const buf = try allocator.allocSentinel(u16, s.len + 1, 0);
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        buf[i] = s[i];
    }
    buf[s.len] = 0;
    return buf[0..s.len :0];
}

/// Trigger UAC elevation by re-launching this exe with "runas".
fn relaunchElevated(allocator: std.mem.Allocator) !bool {
    const exe_path = try getExePath(allocator);
    const runas = try toUtf16(allocator, "runas");
    const setup_arg = try toUtf16(allocator, "--setup");
    var sei = std.mem.zeroes(SHELLEXECUTEINFOW);
    sei.cbSize = @sizeOf(SHELLEXECUTEINFOW);
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = @ptrCast(runas.ptr);
    sei.lpFile = @ptrCast(exe_path.ptr);
    sei.lpParameters = @ptrCast(setup_arg.ptr);
    sei.nShow = SW_HIDE;
    const ok = ShellExecuteExW(&sei);
    if (ok == 0) return false;
    // Wait for the elevated child to finish.
    if (sei.hProcess) |hproc| {
        _ = WaitForSingleObject(hproc, 0xFFFFFFFF);
        _ = CloseHandle(hproc);
    }
    return true;
}

extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: u32) callconv(.winapi) u32;

/// Resolve the sandbox root directory: %LOCALAPPDATA%\eidolon\windows-sandbox.
fn resolveSandboxDir(allocator: std.mem.Allocator) ![:0]u16 {
    const local_appdata = [_:0]u16{ 'L', 'O', 'C', 'A', 'L', 'A', 'P', 'P', 'D', 'A', 'T', 'A', 0 };
    var buf = try allocator.allocSentinel(u16, 4096, 0);
    const n = GetEnvironmentVariableW(&local_appdata, buf.ptr, @intCast(buf.len - 64));
    if (n == 0) return error.NoLocalAppData;
    // Append \eidolon\windows-sandbox
    var idx: usize = n;
    const suffix = "\\eidolon\\windows-sandbox";
    for (suffix) |c| { buf[idx] = c; idx += 1; }
    buf[idx] = 0;
    return buf[0..idx :0];
}

extern "kernel32" fn GetEnvironmentVariableW(lpName: [*:0]const u16, lpBuffer: [*]u16, nSize: u32) callconv(.winapi) u32;

/// Write the setup marker file into the sandbox dir.
fn writeMarker(allocator: std.mem.Allocator, sandbox_dir: [:0]const u16) !void {
    // Build marker path: <sandbox_dir>\setup.marker.json
    var marker_path = try allocator.allocSentinel(u16, sandbox_dir.len + 32, 0);
    @memcpy(marker_path[0..sandbox_dir.len], sandbox_dir);
    var idx: usize = sandbox_dir.len;
    const suffix = "\\" ++ MARKER_FILE_NAME;
    for (suffix) |c| { marker_path[idx] = c; idx += 1; }
    marker_path[idx] = 0;

    // Write marker content (UTF-8, simple JSON).
    const content = "{\"version\":\"" ++ SETUP_VERSION ++ "\",\"status\":\"complete\"}\n";
    const h = CreateFileW(marker_path.ptr, 0x40000000, 0, null, 2, 0, null); // GENERIC_WRITE | CREATE_ALWAYS
    if (h == std.os.windows.INVALID_HANDLE_VALUE) return error.CreateMarkerFailed;
    defer _ = CloseHandle(h);
    var written: u32 = 0;
    _ = WriteFile(h, content, @intCast(content.len), &written, null);
}

extern "kernel32" fn CreateFileW(
    lpFileName: [*:0]const u16,
    dwDesiredAccess: u32,
    dwShareMode: u32,
    lpSecurityAttributes: ?*anyopaque,
    dwCreationDisposition: u32,
    dwFlagsAndAttributes: u32,
    hTemplateFile: ?*anyopaque,
) callconv(.winapi) HANDLE;

pub fn main() void {
    if (builtin.os.tag != .windows) {
        printToErr("eidolon-windows-sandbox-setup: only supported on Windows\n");
        return;
    }
    const allocator = std.heap.page_allocator;

    if (!isElevated()) {
        // Not elevated → re-launch with UAC.
        const ok = relaunchElevated(allocator) catch false;
        if (!ok) {
            printToErr("eidolon-windows-sandbox-setup: failed to request elevation\n");
            std.process.exit(1);
        }
        return;
    }

    // Elevated: create sandbox dir + marker.
    const sandbox_dir = resolveSandboxDir(allocator) catch {
        printToErr("eidolon-windows-sandbox-setup: cannot resolve LOCALAPPDATA\n");
        std.process.exit(1);
    };
    _ = CreateDirectoryW(sandbox_dir.ptr, null);
    writeMarker(allocator, sandbox_dir) catch {
        printToErr("eidolon-windows-sandbox-setup: failed to write setup marker\n");
        std.process.exit(1);
    };
    printToErr("eidolon-windows-sandbox-setup: setup complete\n");
}
