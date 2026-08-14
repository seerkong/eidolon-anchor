const std = @import("std");
const builtin = @import("builtin");
const token_mod = @import("token.zig");
const acl_mod = @import("acl.zig");

const HANDLE = *anyopaque;

const MAX_PATH: usize = 260;

// Token access
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;

// Process creation
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x00000400;

const SECURITY_ATTRIBUTES = extern struct {
    nLength: u32,
    lpSecurityDescriptor: ?*anyopaque,
    bInheritHandle: i32,
};

const STARTUPINFOW = extern struct {
    cb: u32,
    lpReserved: ?*u16,
    lpDesktop: ?*u16,
    lpTitle: ?*u16,
    dwX: u32,
    dwY: u32,
    dwXSize: u32,
    dwYSize: u32,
    dwXCountChars: u32,
    dwYCountChars: u32,
    dwFillAttribute: u32,
    dwFlags: u32,
    wShowWindow: u16,
    cbReserved2: u16,
    lpReserved2: ?*anyopaque,
    hStdInput: HANDLE,
    hStdOutput: HANDLE,
    hStdError: HANDLE,
};

const PROCESS_INFORMATION = extern struct {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: u32,
    dwThreadId: u32,
};

extern "advapi32" fn CreateProcessAsUserW(
    hToken: HANDLE,
    lpApplicationName: ?[*:0]const u16,
    lpCommandLine: ?[*:0]u16,
    lpProcessAttributes: ?*SECURITY_ATTRIBUTES,
    lpThreadAttributes: ?*SECURITY_ATTRIBUTES,
    bInheritHandles: i32,
    dwCreationFlags: u32,
    lpEnvironment: ?*anyopaque,
    lpCurrentDirectory: ?[*:0]const u16,
    lpStartupInfo: *STARTUPINFOW,
    lpProcessInformation: *PROCESS_INFORMATION,
) callconv(.winapi) i32;

extern "kernel32" fn GetCurrentProcess() callconv(.winapi) HANDLE;
extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: u32) callconv(.winapi) u32;
extern "kernel32" fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *u32) callconv(.winapi) i32;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) i32;
extern "kernel32" fn GetStdHandle(nStdHandle: u32) callconv(.winapi) HANDLE;
extern "kernel32" fn GetLastError() callconv(.winapi) u32;

const STD_INPUT_HANDLE: u32 = 0xFFFFFFF6;
const STD_OUTPUT_HANDLE: u32 = 0xFFFFFFF5;
const STD_ERROR_HANDLE: u32 = 0xFFFFFFF4;

const RUNNER_VERSION = "0.1.0";

const Mode = enum { read_only, workspace_write };

const RunnerOptions = struct {
    cwd: ?[*:0]const u16 = null,
    mode: Mode = .workspace_write,
    network: bool = true,
    writable_roots: std.ArrayListUnmanaged([]const u8) = .empty,
    deny_writes: std.ArrayListUnmanaged([]const u8) = .empty,
    shell: []const u8 = "cmd.exe",
    command: []const u8 = "",
};

fn toUtf16(allocator: std.mem.Allocator, s: []const u8) ![:0]u16 {
    // Simple UTF-8 → UTF-16 (ASCII-only expected for paths in practice; non-ASCII
    // falls back to lossy conversion via std.unicode).
    const buf = try allocator.allocSentinel(u16, s.len + 1, 0);
    var i: usize = 0;
    var j: usize = 0;
    while (i < s.len) {
        const c = s[i];
        if (c < 0x80) {
            buf[j] = c;
            j += 1;
            i += 1;
        } else {
            // Lossy: replace non-ASCII with '?' to keep the sentinel buffer sized.
            buf[j] = '?';
            j += 1;
            i += 1;
        }
    }
    buf[j] = 0;
    return buf[0..j :0];
}

fn printToErr(msg: []const u8) void {
    var written: u32 = 0;
    const h = GetStdHandle(STD_ERROR_HANDLE);
    _ = WriteFile(h, msg.ptr, @intCast(msg.len), &written, null);
}

extern "kernel32" fn WriteFile(
    hFile: HANDLE,
    lpBuffer: [*]const u8,
    nNumberOfBytesToWrite: u32,
    lpNumberOfBytesWritten: *u32,
    lpOverlapped: ?*anyopaque,
) callconv(.winapi) i32;

extern "kernel32" fn GetCommandLineW() callconv(.winapi) [*:0]u16;

extern "shell32" fn CommandLineToArgvW(
    lpCmdLine: [*:0]const u16,
    pNumArgs: *i32,
) callconv(.winapi) ?[*][*:0]u16;

extern "kernel32" fn LocalFree(hMem: ?*anyopaque) callconv(.winapi) ?*anyopaque;

/// Collect command-line args as UTF-8 (lossy), via CommandLineToArgvW.
fn collectArgs(allocator: std.mem.Allocator) !std.ArrayListUnmanaged([]const u8) {
    const cmdline = GetCommandLineW();
    var argc: i32 = 0;
    const argv_w = CommandLineToArgvW(cmdline, &argc);
    if (argv_w == null) return error.CommandLineToArgvFailed;
    defer _ = LocalFree(@ptrCast(argv_w.?));

    var list = std.ArrayListUnmanaged([]const u8).empty;
    errdefer list.deinit(allocator);
    const argv = argv_w.?;
    var i: i32 = 0;
    while (i < argc) : (i += 1) {
        const arg_w = argv[@intCast(i)];
        // Convert UTF-16 → UTF-8 (lossy for non-ASCII).
        var arg_len: usize = 0;
        while (arg_w[arg_len] != 0) : (arg_len += 1) {}
        var arg = try allocator.alloc(u8, arg_len);
        var j: usize = 0;
        while (j < arg_len) : (j += 1) {
            const c = arg_w[j];
            arg[j] = if (c < 0x80) @intCast(c) else '?';
        }
        try list.append(allocator, arg);
    }
    return list;
}

pub fn main() void {
    if (builtin.os.tag != .windows) {
        printToErr("eidolon-windows-sandbox-runner: only supported on Windows\n");
        return;
    }
    const allocator = std.heap.page_allocator;

    var args = collectArgs(allocator) catch {
        printToErr("eidolon-windows-sandbox-runner: OOM\n");
        return;
    };
    defer args.deinit(allocator);

    // Parse options (argv[0] is the exe path; skip it).
    var opts = RunnerOptions{};
    var i: usize = 1;
    while (i < args.items.len) : (i += 1) {
        const arg = args.items[i];
        if (std.mem.eql(u8, arg, "--cwd") and i + 1 < args.items.len) {
            i += 1;
            opts.cwd = toUtf16(allocator, args.items[i]) catch null;
        } else if (std.mem.eql(u8, arg, "--mode") and i + 1 < args.items.len) {
            i += 1;
            opts.mode = if (std.mem.eql(u8, args.items[i], "read-only")) .read_only else .workspace_write;
        } else if (std.mem.eql(u8, arg, "--network") and i + 1 < args.items.len) {
            i += 1;
            opts.network = !std.mem.eql(u8, args.items[i], "disabled");
        } else if (std.mem.eql(u8, arg, "--writable-root") and i + 1 < args.items.len) {
            i += 1;
            opts.writable_roots.append(allocator, args.items[i]) catch {};
        } else if (std.mem.eql(u8, arg, "--deny-write") and i + 1 < args.items.len) {
            i += 1;
            opts.deny_writes.append(allocator, args.items[i]) catch {};
        } else if (std.mem.eql(u8, arg, "--version")) {
            printToErr("eidolon-windows-sandbox-runner " ++ RUNNER_VERSION ++ "\n");
            return;
        } else if (std.mem.eql(u8, arg, "--")) {
            // Everything after -- is the command: <shell> /d /s /c <command>
            if (i + 1 < args.items.len) {
                opts.shell = args.items[i + 1];
            }
            var k = i + 2;
            while (k < args.items.len) : (k += 1) {
                if (std.mem.eql(u8, args.items[k], "/c") or std.mem.eql(u8, args.items[k], "/C")) {
                    if (k + 1 < args.items.len) {
                        opts.command = args.items[k + 1];
                    }
                    break;
                }
            }
            break;
        }
    }

    if (opts.command.len == 0) {
        printToErr("eidolon-windows-sandbox-runner: no command after -- <shell> /d /s /c <command>\n");
        std.process.exit(2);
    }

    // Resolve capability SIDs for writable roots.
    var cap_sids = std.ArrayListUnmanaged(*anyopaque).empty;
    defer {
        for (cap_sids.items) |sid| token_mod.freeSid(sid);
        cap_sids.deinit(allocator);
    }
    for (opts.writable_roots.items) |root| {
        const sid = token_mod.capabilitySidForRoot(allocator, root) catch {
            printToErr("eidolon-windows-sandbox-runner: failed to allocate capability SID\n");
            std.process.exit(1);
        };
        cap_sids.append(allocator, sid) catch {};
    }

    // Create restricted token.
    var restricted = token_mod.createRestrictedToken(allocator, cap_sids.items) catch {
        printToErr("eidolon-windows-sandbox-runner: CreateRestrictedToken failed\n");
        std.process.exit(1);
    };
    defer restricted.destroy();

    // Apply ACL grants on writable roots (grant capability SID write).
    // Note: for a self-contained runner MVP, grant on the writable roots uses
    // each root's capability SID. Protected metadata dirs get deny-write.
    for (opts.writable_roots.items, 0..) |root, idx| {
        const path_z = toUtf16(allocator, root) catch continue;
        const sid = if (idx < cap_sids.items.len) cap_sids.items[idx] else continue;
        if (opts.mode == .workspace_write) {
            acl_mod.grantCapabilityWrite(path_z, sid) catch {
                printToErr("eidolon-windows-sandbox-runner: grantCapabilityWrite failed\n");
                std.process.exit(1);
            };
        }
    }
    for (opts.deny_writes.items, 0..) |path, idx| {
        const path_z = toUtf16(allocator, path) catch continue;
        const sid = if (idx < cap_sids.items.len) cap_sids.items[idx] else continue;
        acl_mod.denyWrite(path_z, sid) catch {
            printToErr("eidolon-windows-sandbox-runner: denyWrite failed\n");
            std.process.exit(1);
        };
    }

    // Build command line: <shell> /d /s /c <command>
    const cmdline = buildCommandLine(allocator, opts.shell, opts.command) catch {
        printToErr("eidolon-windows-sandbox-runner: OOM building command line\n");
        std.process.exit(1);
    };
    defer allocator.free(cmdline);

    const cwd = opts.cwd orelse null;

    var si = std.mem.zeroes(STARTUPINFOW);
    si.cb = @sizeOf(STARTUPINFOW);
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    si.dwFlags = 0x0001; // STARTF_USESTDHANDLES

    var pi = std.mem.zeroes(PROCESS_INFORMATION);
    const ok = CreateProcessAsUserW(
        restricted.handle,
        null,
        cmdline.ptr,
        null,
        null,
        1, // inherit handles so child gets stdio
        CREATE_UNICODE_ENVIRONMENT,
        null,
        cwd,
        &si,
        &pi,
    );
    if (ok == 0) {
        var buf: [128]u8 = undefined;
        const s = std.fmt.bufPrint(&buf, "eidolon-windows-sandbox-runner: CreateProcessAsUserW failed (err={d})\n", .{GetLastError()}) catch "CreateProcessAsUserW failed\n";
        printToErr(s);
        std.process.exit(1);
    }
    defer {
        _ = CloseHandle(pi.hProcess);
        _ = CloseHandle(pi.hThread);
    }

    _ = WaitForSingleObject(pi.hProcess, 0xFFFFFFFF); // INFINITE
    var exit_code: u32 = 1;
    _ = GetExitCodeProcess(pi.hProcess, &exit_code);
    std.process.exit(@intCast(@min(exit_code, 255)));
}

/// Build "<shell> /d /s /c <command>" as a mutable NUL-terminated UTF-16 buffer.
fn buildCommandLine(allocator: std.mem.Allocator, shell: []const u8, command: []const u8) ![:0]u16 {
    // shell + " /d /s /c " + command (plus quotes if needed)
    var buf = std.ArrayListUnmanaged(u8).empty;
    errdefer buf.deinit(allocator);
    try buf.appendSlice(allocator, shell);
    try buf.appendSlice(allocator, " /d /s /c ");
    try buf.appendSlice(allocator, command);
    return toUtf16(allocator, buf.items);
}
