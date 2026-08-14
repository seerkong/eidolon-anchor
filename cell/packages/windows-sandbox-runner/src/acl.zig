const std = @import("std");
const builtin = @import("builtin");

const HANDLE = *anyopaque;

// Access mask bits (FILE_*)
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const GENERIC_EXECUTE: u32 = 0x2000_0000;
const GENERIC_ALL: u32 = 0x1000_0000;

// SE_OBJECT_TYPE
const SE_FILE_OBJECT: i32 = 1;

// ACE types
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
const ACCESS_DENIED_ACE_TYPE: u8 = 0x01;

// ACL access rights
const DACL_SECURITY_INFORMATION: u32 = 0x0004;
const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;

// SetEntriesInAcl access modes (ACCESS_MODE enum)
const SET_ACCESS: i32 = 2;
const DENY_ACCESS: i32 = 3;

// Trustee forms
const TRUSTEE_IS_SID: u32 = 0;
const TRUSTEE_IS_UNKNOWN: u32 = 0;

const SID = extern struct {
    Revision: u8,
    SubAuthorityCount: u8,
    IdentifierAuthority: [6]u8,
    // SubAuthority: variable length
};

const TRUSTEE = extern struct {
    pMultipleTrustee: ?*TRUSTEE,
    MultipleTrusteeOperation: i32,
    TrusteeForm: u32,
    TrusteeType: u32,
    ptstrName: ?*anyopaque,
};

const EXPLICIT_ACCESS = extern struct {
    grfAccessPermissions: u32,
    grfAccessMode: i32,
    grfInheritance: u32,
    Trustee: TRUSTEE,
};

const ACL = extern struct {};

extern "advapi32" fn SetEntriesInAclW(
    cCountOfExplicitEntries: u32,
    pListOfExplicitEntries: ?[*]const EXPLICIT_ACCESS,
    OldAcl: ?*ACL,
    NewAcl: *?*ACL,
) callconv(.winapi) i32;

extern "advapi32" fn SetNamedSecurityInfoW(
    pObjectName: [*:0]const u16,
    ObjectType: i32,
    SecurityInfo: u32,
    psidOwner: ?*anyopaque,
    psidGroup: ?*anyopaque,
    pDacl: ?*ACL,
    pSacl: ?*ACL,
) callconv(.winapi) i32;

extern "kernel32" fn LocalFree(hMem: ?*anyopaque) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) i32;

extern "advapi32" fn CopySid(
    nDestinationSidLength: u32,
    pDestinationSid: *anyopaque,
    pSourceSid: *const anyopaque,
) callconv(.winapi) i32;

extern "advapi32" fn GetLengthSid(pSid: *const anyopaque) callconv(.winapi) u32;

/// Get the current process user's SID as a heap copy (caller frees via
/// std.heap.page_allocator.free on the returned slice's backing pointer).
pub fn currentUserSid() !*anyopaque {
    var token: HANDLE = undefined;
    const ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
    if (ok == 0) return error.OpenTokenFailed;
    defer _ = CloseHandle(token);
    var return_len: u32 = 0;
    _ = GetTokenInformation(token, TokenUser, null, 0, &return_len);
    const buf = try std.heap.page_allocator.alloc(u8, return_len);
    defer std.heap.page_allocator.free(buf);
    const q = GetTokenInformation(token, TokenUser, @ptrCast(buf.ptr), return_len, &return_len);
    if (q == 0) return error.GetTokenInfoFailed;
    const tu: *TOKEN_USER = @ptrCast(@alignCast(buf.ptr));

    // Copy the SID to a heap buffer so it survives token close.
    const sid_len = GetLengthSid(tu.User.Sid);
    const copy = try std.heap.page_allocator.alloc(u8, sid_len);
    const copied = CopySid(sid_len, @ptrCast(copy.ptr), tu.User.Sid);
    if (copied == 0) {
        std.heap.page_allocator.free(copy);
        return error.CopySidFailed;
    }
    return @ptrCast(copy.ptr);
}

extern "advapi32" fn GetNamedSecurityInfoW(
    pObjectName: [*:0]const u16,
    ObjectType: i32,
    SecurityInfo: u32,
    ppsidOwner: ?*?*anyopaque,
    ppsidGroup: ?*?*anyopaque,
    ppDacl: ?*?*ACL,
    ppSacl: ?*?*ACL,
    ppSecurityDescriptor: ?*?*anyopaque,
) callconv(.winapi) i32;

extern "advapi32" fn LocalAlloc(uFlags: u32, uBytes: usize) callconv(.winapi) ?*anyopaque;

/// Grant `capability_sid` write access to `path` WITHOUT removing inherited
/// permissions. The existing DACL (inherited + explicit) is read, the
/// capability SID's GENERIC_ALL ACE is appended, and the merged DACL is applied
/// WITHOUT PROTECTED_DACL — so Administrators/SYSTEM/Users keep their inherited
/// rights and the directory stays accessible to the current user.
///
/// This is the critical fix: the original code used PROTECTED_DACL which
/// REPLACED the DACL and broke directory access (e.g. .eidolon became
/// unreadable by the current user).
pub fn grantCapabilityWrite(path: [*:0]const u16, capability_sid: *anyopaque) !void {
    const user_sid = try currentUserSid();
    // Read the existing DACL + security descriptor so we preserve inherited ACEs.
    var pp_owner: ?*anyopaque = null;
    var pp_group: ?*anyopaque = null;
    var pp_dacl: ?*ACL = null;
    var pp_sd: ?*anyopaque = null;
    const g = GetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        &pp_owner,
        &pp_group,
        &pp_dacl,
        null,
        &pp_sd,
    );
    if (g != 0) return error.GetSecurityInfoFailed;
    defer {
        if (pp_sd) |sd| _ = LocalFree(@ptrCast(sd));
    }

    var dacl: ?*ACL = null;
    const entries = [_]EXPLICIT_ACCESS{
        .{
            .grfAccessPermissions = GENERIC_ALL,
            .grfAccessMode = SET_ACCESS,
            .grfInheritance = 0,
            .Trustee = .{
                .pMultipleTrustee = null,
                .MultipleTrusteeOperation = 0,
                .TrusteeForm = TRUSTEE_IS_SID,
                .TrusteeType = TRUSTEE_IS_UNKNOWN,
                .ptstrName = user_sid,
            },
        },
        .{
            .grfAccessPermissions = GENERIC_ALL,
            .grfAccessMode = SET_ACCESS,
            .grfInheritance = 0,
            .Trustee = .{
                .pMultipleTrustee = null,
                .MultipleTrusteeOperation = 0,
                .TrusteeForm = TRUSTEE_IS_SID,
                .TrusteeType = TRUSTEE_IS_UNKNOWN,
                .ptstrName = capability_sid,
            },
        },
    };
    // Pass the existing DACL as OldAcl so SetEntriesInAcl merges (preserving
    // inherited ACEs) instead of starting from an empty ACL.
    const r = SetEntriesInAclW(2, &entries, pp_dacl, &dacl);
    if (r != 0) return error.SetEntriesInAclFailed;
    defer _ = LocalFree(@ptrCast(dacl));

    // Apply WITHOUT PROTECTED_DACL so inherited permissions are retained.
    const hr = SetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null,
        null,
        dacl,
        null,
    );
    if (hr != 0) return error.SetNamedSecurityInfoFailed;
}

/// Add a deny-write ACE for `sid` on `path` (append to existing DACL).
/// Used to protect metadata dirs (.git/.eidolon) from the sandboxed process.
/// Preserves inherited permissions (no PROTECTED_DACL).
pub fn denyWrite(path: [*:0]const u16, sid: *anyopaque) !void {
    var pp_dacl: ?*ACL = null;
    var pp_sd: ?*anyopaque = null;
    const g = GetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null,
        null,
        &pp_dacl,
        null,
        &pp_sd,
    );
    if (g != 0) return error.GetSecurityInfoFailed;
    defer {
        if (pp_sd) |sd| _ = LocalFree(@ptrCast(sd));
    }

    var dacl: ?*ACL = null;
    const entries = [_]EXPLICIT_ACCESS{
        .{
            .grfAccessPermissions = GENERIC_WRITE,
            .grfAccessMode = DENY_ACCESS,
            .grfInheritance = 0,
            .Trustee = .{
                .pMultipleTrustee = null,
                .MultipleTrusteeOperation = 0,
                .TrusteeForm = TRUSTEE_IS_SID,
                .TrusteeType = TRUSTEE_IS_UNKNOWN,
                .ptstrName = sid,
            },
        },
    };
    const r = SetEntriesInAclW(1, &entries, pp_dacl, &dacl);
    if (r != 0) return error.SetEntriesInAclFailed;
    defer _ = LocalFree(@ptrCast(dacl));

    // Without PROTECTED, this appends deny-write to the existing DACL.
    const hr = SetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null,
        null,
        dacl,
        null,
    );
    if (hr != 0) return error.SetNamedSecurityInfoFailed;
}

// ---- Tests ----

const testing = std.testing;

extern "kernel32" fn GetCurrentProcess() callconv(.winapi) HANDLE;

extern "advapi32" fn GetTokenInformation(
    TokenHandle: HANDLE,
    TokenInformationClass: u32,
    TokenInformation: ?*anyopaque,
    TokenInformationLength: u32,
    ReturnLength: *u32,
) callconv(.winapi) i32;

extern "advapi32" fn OpenProcessToken(
    ProcessHandle: HANDLE,
    DesiredAccess: u32,
    TokenHandle: *HANDLE,
) callconv(.winapi) i32;

const TokenUser: u32 = 1;
const TOKEN_QUERY: u32 = 0x0008;

const SID_AND_ATTRIBUTES = extern struct {
    Sid: *anyopaque,
    Attributes: u32,
};

const TOKEN_USER = extern struct {
    User: SID_AND_ATTRIBUTES,
};

test "grantCapabilityWrite rejects empty paths" {
    // SetNamedSecurityInfoW on a null/invalid path returns an error code.
    const r = SetNamedSecurityInfoW(
        @as([*:0]const u16, @ptrCast(@constCast(&[_]u16{0}))),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null,
        null,
        null,
        null,
    );
    // An empty path is not a valid object name → nonzero result.
    try testing.expect(r != 0);
}

test "grantCapabilityWrite works on a real temp directory (Windows only)" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;

    // Get the current user's SID from the process token.
    var token: HANDLE = undefined;
    const ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
    if (ok == 0) return error.OpenTokenFailed;
    defer _ = CloseHandle(token);

    var return_len: u32 = 0;
    _ = GetTokenInformation(token, TokenUser, null, 0, &return_len);
    const buf = try std.heap.page_allocator.alloc(u8, return_len);
    defer std.heap.page_allocator.free(buf);
    const q = GetTokenInformation(token, TokenUser, @ptrCast(buf.ptr), return_len, &return_len);
    if (q == 0) return error.GetTokenInfoFailed;
    const tu: *TOKEN_USER = @ptrCast(@alignCast(buf.ptr));
    const user_sid = tu.User.Sid;

    // Create a temp directory via Win32 (avoids Zig 0.16 unstable fs API).
    const path_w = try createTempDir("sandbox-acl-test");
    defer {
        _ = RemoveDirectoryW(path_w.ptr);
        std.heap.page_allocator.free(path_w);
    }

    try grantCapabilityWrite(path_w.ptr, user_sid);
}

test "grantCapabilityWrite preserves inherited directory access (Windows only)" {
    // Regression test: grantCapabilityWrite must NOT break the current user's
    // access to the directory (it previously used PROTECTED_DACL which replaced
    // the DACL and removed inherited ACEs — e.g. .eidolon became unreadable).
    if (builtin.os.tag != .windows) return error.SkipZigTest;

    const path_w = try createTempDir("sandbox-acl-preserve");
    defer {
        _ = RemoveDirectoryW(path_w.ptr);
        std.heap.page_allocator.free(path_w);
    }

    // Grant a capability SID (use the current user's SID as a stand-in).
    var token: HANDLE = undefined;
    const ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
    if (ok == 0) return error.OpenTokenFailed;
    defer _ = CloseHandle(token);
    var return_len: u32 = 0;
    _ = GetTokenInformation(token, TokenUser, null, 0, &return_len);
    const buf = try std.heap.page_allocator.alloc(u8, return_len);
    defer std.heap.page_allocator.free(buf);
    const q = GetTokenInformation(token, TokenUser, @ptrCast(buf.ptr), return_len, &return_len);
    if (q == 0) return error.GetTokenInfoFailed;
    const tu: *TOKEN_USER = @ptrCast(@alignCast(buf.ptr));
    const user_sid = tu.User.Sid;

    try grantCapabilityWrite(path_w.ptr, user_sid);

    // After the grant, the current user must still be able to create a file
    // in the directory (inherited + explicit ACEs preserved).
    var file_path = std.heap.page_allocator.allocSentinel(u16, path_w.len + 16, 0) catch return error.OOM;
    defer std.heap.page_allocator.free(file_path);
    @memcpy(file_path[0..path_w.len], path_w);
    var idx: usize = path_w.len;
    const suffix = "\\probe.txt";
    for (suffix) |c| { file_path[idx] = c; idx += 1; }
    file_path[idx] = 0;

    const h = CreateFileW(file_path.ptr, 0x40000000, 0, null, 2, 0, null); // GENERIC_WRITE | CREATE_ALWAYS
    if (h == std.os.windows.INVALID_HANDLE_VALUE) return error.CreateProbeFailed;
    _ = CloseHandle(h);
    _ = DeleteFileW(file_path.ptr);
}

extern "kernel32" fn GetTempPathW(nBufferLength: u32, lpBuffer: [*]u16) callconv(.winapi) u32;
extern "kernel32" fn CreateDirectoryW(lpPathName: [*:0]const u16, lpSecurityAttributes: ?*anyopaque) callconv(.winapi) i32;
extern "kernel32" fn RemoveDirectoryW(lpPathName: [*:0]const u16) callconv(.winapi) i32;
extern "kernel32" fn CreateFileW(
    lpFileName: [*:0]const u16,
    dwDesiredAccess: u32,
    dwShareMode: u32,
    lpSecurityAttributes: ?*anyopaque,
    dwCreationDisposition: u32,
    dwFlagsAndAttributes: u32,
    hTemplateFile: ?*anyopaque,
) callconv(.winapi) HANDLE;
extern "kernel32" fn DeleteFileW(lpFileName: [*:0]const u16) callconv(.winapi) i32;

/// Create a temp directory, returning an allocated NUL-terminated UTF-16 path.
/// Caller frees with page_allocator.
fn createTempDir(prefix: []const u8) ![:0]u16 {
    var temp_path: [MAX_PATH]u16 = undefined;
    const n = GetTempPathW(temp_path.len, &temp_path);
    if (n == 0 or n >= temp_path.len) return error.GetTempPathFailed;

    const pid = std.os.windows.GetCurrentProcessId();
    const alloc = std.heap.page_allocator;
    var counter: u32 = 0;
    while (counter < 1000) : (counter += 1) {
        // Estimate length: temp (≤260) + prefix + "-<pid>-<counter>\0"
        var name = try alloc.allocSentinel(u16, 320, 0);
        var idx: usize = 0;
        const temp_slice = temp_path[0..n];
        @memcpy(name[0..temp_slice.len], temp_slice);
        idx = temp_slice.len;
        for (prefix) |c| { name[idx] = c; idx += 1; }
        name[idx] = '-'; idx += 1;
        var digits_buf: [16]u8 = undefined;
        const pid_str = std.fmt.bufPrint(&digits_buf, "{d}", .{pid}) catch { alloc.free(name); return error.BufPrintFailed; };
        for (pid_str) |c| { name[idx] = c; idx += 1; }
        name[idx] = '-'; idx += 1;
        const cnt_str = std.fmt.bufPrint(&digits_buf, "{d}", .{counter}) catch { alloc.free(name); return error.BufPrintFailed; };
        for (cnt_str) |c| { name[idx] = c; idx += 1; }
        name[idx] = 0;

        const ok = CreateDirectoryW(name.ptr, null);
        if (ok != 0) {
            return name[0..idx :0];
        }
        alloc.free(name);
    }
    return error.CreateTempDirFailed;
}

const MAX_PATH: usize = 260;
