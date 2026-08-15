const std = @import("std");
const builtin = @import("builtin");
const account = @import("account.zig");
const wfp = @import("wfp.zig");

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

/// Append to a fixed log file so the elevated child's output is observable by
/// the parent (stderr of an elevated child is not visible).
fn logToFile(msg: []const u8) void {
    var path_buf: [1024]u16 = undefined;
    const userprofile = [_:0]u16{ 'U', 'S', 'E', 'R', 'P', 'R', 'O', 'F', 'I', 'L', 'E', 0 };
    const n = GetEnvironmentVariableW(&userprofile, &path_buf, @intCast(path_buf.len - 40));
    if (n == 0) return;
    var idx: usize = n;
    const suffix = "\\AppData\\Local\\eidolon\\setup.log";
    for (suffix) |c| { path_buf[idx] = c; idx += 1; }
    path_buf[idx] = 0;
    const h = CreateFileW(path_buf[0..idx :0], 0x40000000, 0, null, 4, 0, null); // GENERIC_WRITE | OPEN_ALWAYS
    if (h == std.os.windows.INVALID_HANDLE_VALUE) return;
    defer _ = CloseHandle(h);
    _ = SetFilePointer(h, 0, null, 2); // FILE_END
    var written: u32 = 0;
    _ = WriteFile(h, msg.ptr, @intCast(msg.len), &written, null);
}

extern "kernel32" fn SetFilePointer(hFile: HANDLE, lDistanceToMove: i32, lpDistanceToMoveHigh: ?*i32, dwMoveMethod: u32) callconv(.winapi) u32;

fn printToErr(msg: []const u8) void {
    var written: u32 = 0;
    const h = GetStdHandle(STD_ERROR_HANDLE);
    _ = WriteFile(h, msg.ptr, @intCast(msg.len), &written, null);
    logToFile(msg);
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
/// Falls back to %USERPROFILE%\AppData\Local (elevated children may lack
/// the LOCALAPPDATA env var).
fn resolveSandboxDir(allocator: std.mem.Allocator) ![:0]u16 {
    const local_appdata = [_:0]u16{ 'L', 'O', 'C', 'A', 'L', 'A', 'P', 'P', 'D', 'A', 'T', 'A', 0 };
    var buf = try allocator.allocSentinel(u16, 4096, 0);
    var n = GetEnvironmentVariableW(&local_appdata, buf.ptr, @intCast(buf.len - 64));
    if (n == 0) {
        // Fallback: derive from USERPROFILE + \AppData\Local (elevated children
        // usually keep USERPROFILE even when LOCALAPPDATA is missing).
        const userprofile = [_:0]u16{ 'U', 'S', 'E', 'R', 'P', 'R', 'O', 'F', 'I', 'L', 'E', 0 };
        n = GetEnvironmentVariableW(&userprofile, buf.ptr, @intCast(buf.len - 64));
        if (n == 0) return error.NoLocalAppData;
        const appdata = "\\AppData\\Local";
        for (appdata) |c| { buf[n] = c; n += 1; }
    }
    // Append \eidolon\windows-sandbox
    var idx: usize = n;
    const suffix = "\\eidolon\\windows-sandbox";
    for (suffix) |c| { buf[idx] = c; idx += 1; }
    buf[idx] = 0;
    return buf[0..idx :0];
}

extern "kernel32" fn GetEnvironmentVariableW(lpName: [*:0]const u16, lpBuffer: [*]u16, nSize: u32) callconv(.winapi) u32;
extern "advapi32" fn LookupAccountNameW(
    lpSystemName: ?[*:0]const u16,
    lpAccountName: [*:0]const u16,
    Sid: ?[*]u8,
    cbSid: *u32,
    ReferencedDomainName: ?[*:0]u16,
    cchReferencedDomainName: *u32,
    peUse: ?*i32,
) callconv(.winapi) i32;

/// Look up an account's SID (page_allocator heap copy; not freed — setup is short-lived).
fn lookupAccountSid(allocator: std.mem.Allocator, name: []const u8) !*anyopaque {
    const name_w = try allocator.allocSentinel(u16, name.len + 1, 0);
    defer allocator.free(name_w);
    for (name, 0..) |c, i| name_w[i] = c;
    name_w[name.len] = 0;
    var sid_size: u32 = 0;
    var dom_size: u32 = 0;
    var use: i32 = 0;
    _ = LookupAccountNameW(null, name_w.ptr, null, &sid_size, null, &dom_size, &use);
    const buf = try allocator.alloc(u8, sid_size);
    const ok = LookupAccountNameW(null, name_w.ptr, buf.ptr, &sid_size, null, &dom_size, &use);
    if (ok == 0) {
        allocator.free(buf);
        return error.LookupAccountFailed;
    }
    return @ptrCast(buf.ptr);
}

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

/// Write the DPAPI-encrypted account password to <sandbox_dir>\<file_name>.
fn writeAccountPassword(allocator: std.mem.Allocator, sandbox_dir: [:0]const u16, file_name: []const u8, blob: []const u8) !void {
    var path = try allocator.allocSentinel(u16, sandbox_dir.len + 64, 0);
    @memcpy(path[0..sandbox_dir.len], sandbox_dir);
    var idx: usize = sandbox_dir.len;
    const suffix = "\\";
    for (suffix) |c| { path[idx] = c; idx += 1; }
    for (file_name) |c| { path[idx] = c; idx += 1; }
    path[idx] = 0;

    const h = CreateFileW(path.ptr, 0x40000000, 0, null, 2, 0, null); // GENERIC_WRITE | CREATE_ALWAYS
    if (h == std.os.windows.INVALID_HANDLE_VALUE) return error.CreatePasswordFileFailed;
    defer _ = CloseHandle(h);
    var written: u32 = 0;
    _ = WriteFile(h, blob.ptr, @intCast(blob.len), &written, null);
}

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

    // Elevated: create sandbox dir + account + marker.
    const sandbox_dir = resolveSandboxDir(allocator) catch {
        printToErr("eidolon-windows-sandbox-setup: cannot resolve LOCALAPPDATA\n");
        std.process.exit(1);
    };
    _ = CreateDirectoryW(sandbox_dir.ptr, null);

    // Create the sandbox account and store its DPAPI-encrypted password.
    // Create both sandbox accounts (online + offline), each with its own
    // DPAPI-encrypted password file.
    setupOneAccount(allocator, sandbox_dir, account.SANDBOX_ACCOUNT_ONLINE) catch {
        printToErr("eidolon-windows-sandbox-setup: failed to set up online account\n");
        std.process.exit(1);
    };
    setupOneAccount(allocator, sandbox_dir, account.SANDBOX_ACCOUNT_OFFLINE) catch {
        printToErr("eidolon-windows-sandbox-setup: failed to set up offline account\n");
        std.process.exit(1);
    };

    // Remove the legacy single account (single-account design).
    account.deleteSandboxAccount(allocator, account.SANDBOX_ACCOUNT_NAME) catch {};

    writeMarker(allocator, sandbox_dir) catch {
        printToErr("eidolon-windows-sandbox-setup: failed to write setup marker\n");
        std.process.exit(1);
    };

    // Install WFP outbound-block filters for the OFFLINE account unconditionally:
    // the offline account exists precisely to be network-isolated. This is not
    // gated on a setup flag — network choice happens per-command via --network
    // in the runner (enabled → online account, disabled → offline account).
    const sid = lookupAccountSid(allocator, account.SANDBOX_ACCOUNT_OFFLINE) catch null;
    if (sid) |s| {
        wfp.installOutboundBlockForSid(s) catch {
            printToErr("eidolon-windows-sandbox-setup: WFP filter install failed (network isolation disabled)\n");
        };
    }
    printToErr("eidolon-windows-sandbox-setup: setup complete (dual accounts created)\n");
}

/// Create one sandbox account and store its DPAPI-encrypted password.
fn setupOneAccount(allocator: std.mem.Allocator, sandbox_dir: [:0]const u16, name: []const u8) !void {
    const password = try account.createSandboxAccount(allocator, name);
    defer allocator.free(password);
    const encrypted = try account.dpapiProtect(allocator, password);
    defer allocator.free(encrypted);
    try writeAccountPassword(allocator, sandbox_dir, account.passwordFileFor(name), encrypted);
}
