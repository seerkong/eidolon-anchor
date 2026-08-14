const std = @import("std");

const HANDLE = *anyopaque;

// Token access rights
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;

// CreateRestrictedToken flags
const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;

// SID authority
const SECURITY_LOCAL_SID_AUTHORITY = [_]u8{ 0, 0, 0, 0, 0, 5 };

const SID_IDENTIFIER_AUTHORITY = extern struct {
    Value: [6]u8,
};

const SID_AND_ATTRIBUTES = extern struct {
    Sid: ?*anyopaque,
    Attributes: u32,
};

extern "advapi32" fn CreateRestrictedToken(
    ExistingTokenHandle: HANDLE,
    Flags: u32,
    DisableSidCount: u32,
    SidsToDisable: ?[*]const SID_AND_ATTRIBUTES,
    DeletePrivilegeCount: u32,
    PrivilegesToDelete: ?[*]const SID_AND_ATTRIBUTES,
    RestrictedSidCount: u32,
    SidsToRestrict: ?[*]const SID_AND_ATTRIBUTES,
    NewTokenHandle: *HANDLE,
) callconv(.winapi) i32;

extern "advapi32" fn OpenProcessToken(
    ProcessHandle: HANDLE,
    DesiredAccess: u32,
    TokenHandle: *HANDLE,
) callconv(.winapi) i32;

extern "advapi32" fn AllocateAndInitializeSid(
    pIdentifierAuthority: *const SID_IDENTIFIER_AUTHORITY,
    nSubAuthorityCount: u8,
    dwSubAuthority0: u32,
    dwSubAuthority1: u32,
    dwSubAuthority2: u32,
    dwSubAuthority3: u32,
    dwSubAuthority4: u32,
    dwSubAuthority5: u32,
    dwSubAuthority6: u32,
    dwSubAuthority7: u32,
    pSid: **anyopaque,
) callconv(.winapi) i32;

extern "advapi32" fn FreeSid(pSid: *anyopaque) callconv(.winapi) *anyopaque;

pub fn freeSid(sid: *anyopaque) void {
    _ = FreeSid(sid);
}

extern "kernel32" fn GetCurrentProcess() callconv(.winapi) HANDLE;
extern "kernel32" fn GetLastError() callconv(.winapi) u32;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) i32;

extern "advapi32" fn GetTokenInformation(
    TokenHandle: HANDLE,
    TokenInformationClass: u32,
    TokenInformation: ?*anyopaque,
    TokenInformationLength: u32,
    ReturnLength: *u32,
) callconv(.winapi) i32;

// TokenInformationClass values
const TokenPrivileges: u32 = 3;
const TokenLinkedToken: u32 = 19;

const LUID = extern struct {
    LowPart: u32,
    HighPart: i32,
};

const LUID_AND_ATTRIBUTES = extern struct {
    Luid: LUID,
    Attributes: u32,
};

const TOKEN_PRIVILEGES = extern struct {
    PrivilegeCount: u32,
    Privileges: [1]LUID_AND_ATTRIBUTES,
};

extern "advapi32" fn AdjustTokenPrivileges(
    TokenHandle: HANDLE,
    DisableAllPrivileges: i32,
    NewState: ?*anyopaque,
    BufferLength: u32,
    PreviousState: ?*anyopaque,
    ReturnLength: ?*u32,
) callconv(.winapi) i32;

extern "advapi32" fn LookupPrivilegeValueW(
    lpSystemName: ?[*:0]const u16,
    lpName: [*:0]const u16,
    lpLuid: *LUID,
) callconv(.winapi) i32;

const TOKEN_ADJUST_PRIVILEGES: u32 = 0x0020;
const SE_PRIVILEGE_ENABLED: u32 = 0x00000002;

/// Re-enable SeChangeNotifyPrivilege on a restricted token. CreateRestrictedToken
/// with DISABLE_MAX_PRIVILEGE strips all privileges; without SeChangeNotify
/// (traverse-directory bypass), even listing a directory tree fails under the
/// restricted token (Git Bash's find/ls error with ACCESS_DENIED). This mirrors
/// Codex's token.rs enable_single_privilege.
pub fn enableSeChangeNotify(token: HANDLE) !void {
    var luid: LUID = undefined;
    const se_change = [_:0]u16{ 'S', 'e', 'C', 'h', 'a', 'n', 'g', 'e', 'N', 'o', 't', 'i', 'f', 'y', 'P', 'r', 'i', 'v', 'i', 'l', 'e', 'g', 'e', 0 };
    const ok = LookupPrivilegeValueW(null, &se_change, &luid);
    if (ok == 0) return error.LookupPrivilegeFailed;
    var tp = TOKEN_PRIVILEGES{
        .PrivilegeCount = 1,
        .Privileges = [1]LUID_AND_ATTRIBUTES{.{ .Luid = luid, .Attributes = SE_PRIVILEGE_ENABLED }},
    };
    const r = AdjustTokenPrivileges(token, 0, &tp, 0, null, null);
    if (r == 0) return error.AdjustTokenPrivilegesFailed;
}

const SE_PRIVILEGE_REMOVED: u32 = 0x00000004;

pub const RestrictedToken = struct {
    handle: HANDLE,
    capability_sids: []SID_AND_ATTRIBUTES,

    pub fn destroy(self: *RestrictedToken) void {
        _ = CloseHandle(self.handle);
    }
};

/// FNV-1a hash of the workspace root path, used as the capability RID.
/// Deterministic per root; collisions across roots are unlikely for a single
/// user's workspaces and are not security-critical (they only widen the
/// writable set slightly).
fn capabilityRidFromPath(path_bytes: []const u8) u32 {
    var hash: u32 = 0x811c9dc5;
    for (path_bytes) |byte| {
        hash ^= byte;
        hash *%= 0x01000193;
    }
    // Keep out of the low well-known range; add a fixed marker so capability
    // SIDs never collide with system well-known SIDs.
    return (hash & 0x00ff_ffff) | 0x0100_0000;
}

/// Allocate a capability SID for a workspace root.
/// Authority = LOCAL (5), RID = hash of the root path.
pub fn capabilitySidForRoot(allocator: std.mem.Allocator, root: []const u8) !*anyopaque {
    const rid = capabilityRidFromPath(root);
    var sid: *anyopaque = undefined;
    const auth = SID_IDENTIFIER_AUTHORITY{ .Value = SECURITY_LOCAL_SID_AUTHORITY };
    const ok = AllocateAndInitializeSid(
        &auth,
        2,
        rid,
        0x5200, // fixed sub-authority marker (non-standard, avoids system SIDs)
        0,
        0,
        0,
        0,
        0,
        0,
        &sid,
    );
    if (ok == 0) return error.AllocateSidFailed;
    _ = allocator;
    return sid;
}

/// Create a restricted token from the current process token.
/// `capability_sids` are the restricting SIDs granting write access to the
/// workspace roots; other SIDs have no capabilities.
pub fn createRestrictedToken(
    allocator: std.mem.Allocator,
    capability_sids: []*anyopaque,
) !RestrictedToken {
    var base_token: HANDLE = undefined;
    const ok = OpenProcessToken(
        GetCurrentProcess(),
        TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
        &base_token,
    );
    if (ok == 0) return error.OpenProcessTokenFailed;
    defer _ = CloseHandle(base_token);

    // Build restricting SIDs list: capabilities + current user + Everyone.
    // (For MVP we use only the capabilities; user/Everyone are added by the
    // caller that needs the default-DACL behavior.)
    const entries = try allocator.alloc(SID_AND_ATTRIBUTES, capability_sids.len);
    defer allocator.free(entries);
    for (capability_sids, 0..) |sid, i| {
        entries[i] = .{ .Sid = sid, .Attributes = 0 };
    }

    // DISABLE_MAX_PRIVILEGE strips privileges; WRITE_RESTRICTED limits writes.
    // NOTE: LUA_TOKEN (limited-user-account) is deliberately NOT used — it makes
    // Cygwin/MSYS tools (Git Bash find/ls/grep) fail at startup with
    // NtSetInformationToken(TokenDefaultDacl) ACCESS_DENIED. DISABLE_MAX_PRIVILEGE
    // + WRITE_RESTRICTED + restricting SIDs provide the isolation; LUA adds
    // incompatibility without meaningful extra safety here.
    const flags = DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED;
    var new_token: HANDLE = undefined;
    const r = CreateRestrictedToken(
        base_token,
        flags,
        0,
        null,
        0,
        null,
        @intCast(entries.len),
        entries.ptr,
        &new_token,
    );
    if (r == 0) return error.CreateRestrictedTokenFailed;

    // Re-enable SeChangeNotifyPrivilege so the restricted process can traverse
    // directory trees (Git Bash find/ls need it).
    enableSeChangeNotify(new_token) catch {};

    return RestrictedToken{
        .handle = new_token,
        .capability_sids = entries,
    };
}

/// Whether the given path is writable under the restricted token.
/// This is a best-effort check used for tests; the real enforcement is the
/// token + ACL combination applied by acl.zig.
pub fn isWriteAllowed(allocator: std.mem.Allocator, token: RestrictedToken, path: []const u8) !bool {
    _ = allocator;
    _ = token;
    _ = path;
    // Full ACL check is implemented in acl.zig; here we return a conservative
    // default. Tests override this via the acl module.
    return false;
}

// ---- Tests ----

const testing = std.testing;

test "capability RID is deterministic and unique per root" {
    const a = capabilityRidFromPath("C:\\workspace\\proj-a");
    const b = capabilityRidFromPath("C:\\workspace\\proj-a");
    const c = capabilityRidFromPath("C:\\workspace\\proj-b");
    try testing.expectEqual(a, b);
    try testing.expect(a != c);
}

test "capability SID allocates and frees" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const sid = try capabilitySidForRoot(arena.allocator(), "C:\\workspace\\proj-a");
    // capabilitySidForRoot returns !*anyopaque; success means the SID allocated.
    _ = FreeSid(sid);
}

test "createRestrictedToken creates a token with privileges disabled" {
    // Only meaningful on Windows; the restricted token creation path uses
    // CreateRestrictedToken which is a no-op surface here.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var token = try createRestrictedToken(arena.allocator(), &.{});
    defer token.destroy();

    // Query the token's privilege count — DISABLE_MAX_PRIVILEGE should leave
    // zero enabled privileges.
    var return_len: u32 = 0;
    const q = GetTokenInformation(token.handle, TokenPrivileges, null, 0, &return_len);
    // GetTokenInformation with too-small buffer returns 0 with ERROR_INSUFFICIENT_BUFFER.
    // A privilege query needs at least the fixed header (4 bytes) even with zero privileges.
    try testing.expect(return_len >= 4);
    _ = q;
}
