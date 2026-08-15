const std = @import("std");
const builtin = @import("builtin");

const HANDLE = *anyopaque;

pub const SANDBOX_ACCOUNT_NAME = "eidolon-sandbox";
pub const SANDBOX_ACCOUNT_ONLINE = "eidolon-sandbox-online";
pub const SANDBOX_ACCOUNT_OFFLINE = "eidolon-sandbox-offline";
pub const SANDBOX_ACCOUNT_PASSWORD_FILE = "account-password.bin";
pub const SANDBOX_ACCOUNT_ONLINE_PASSWORD_FILE = "account-password-online.bin";
pub const SANDBOX_ACCOUNT_OFFLINE_PASSWORD_FILE = "account-password-offline.bin";

/// Map an account name to its password filename.
pub fn passwordFileFor(name: []const u8) []const u8 {
    if (std.mem.eql(u8, name, SANDBOX_ACCOUNT_ONLINE)) return SANDBOX_ACCOUNT_ONLINE_PASSWORD_FILE;
    if (std.mem.eql(u8, name, SANDBOX_ACCOUNT_OFFLINE)) return SANDBOX_ACCOUNT_OFFLINE_PASSWORD_FILE;
    return SANDBOX_ACCOUNT_PASSWORD_FILE;
}

// USER_INFO_1 priv levels
const USER_PRIV_USER: u32 = 1;
// USER_INFO_1 flags
const UF_SCRIPT: u32 = 0x0001;
const UF_DONT_EXPIRE_PASSWD: u32 = 0x10000;

const USER_INFO_1 = extern struct {
    usri1_name: [*:0]const u16,
    usri1_password: [*:0]const u16,
    usri1_password_age: u32,
    usri1_priv: u32,
    usri1_home_dir: ?[*:0]const u16,
    usri1_comment: ?[*:0]const u16,
    usri1_flags: u32,
    usri1_script_path: ?[*:0]const u16,
};

extern "netapi32" fn NetUserAdd(
    servername: ?[*:0]const u16,
    level: u32,
    buf: *const USER_INFO_1,
    parm_err: ?*u32,
) callconv(.winapi) i32;

extern "netapi32" fn NetUserSetInfo(
    servername: ?[*:0]const u16,
    username: [*:0]const u16,
    level: u32,
    buf: *const anyopaque,
    parm_err: ?*u32,
) callconv(.winapi) i32;

// USER_INFO_1003 = password only.
const USER_INFO_1003 = extern struct {
    usri1003_password: [*:0]const u16,
};

extern "netapi32" fn NetUserDel(
    servername: ?[*:0]const u16,
    username: [*:0]const u16,
) callconv(.winapi) i32;

// NERR_Success = 0, NERR_UserExists = 2224
const NERR_Success: i32 = 0;
const NERR_UserExists: i32 = 2224;

// DPAPI
const CRYPTOAPI_BLOB = extern struct {
    cbData: u32,
    pbData: ?[*]u8,
};

const DATA_BLOB = CRYPTOAPI_BLOB;

extern "crypt32" fn CryptProtectData(
    pDataIn: *const DATA_BLOB,
    szDataDescr: ?[*:0]const u16,
    pOptionalEntropy: ?*const DATA_BLOB,
    pvReserved: ?*anyopaque,
    pPromptStruct: ?*anyopaque,
    dwFlags: u32,
    pDataOut: *DATA_BLOB,
) callconv(.winapi) i32;

extern "crypt32" fn CryptUnprotectData(
    pDataIn: *const DATA_BLOB,
    ppszDataDescr: ?*?[*:0]u16,
    pOptionalEntropy: ?*const DATA_BLOB,
    pvReserved: ?*anyopaque,
    pPromptStruct: ?*anyopaque,
    dwFlags: u32,
    pDataOut: *DATA_BLOB,
) callconv(.winapi) i32;

extern "kernel32" fn LocalFree(hMem: ?*anyopaque) callconv(.winapi) ?*anyopaque;

// BCrypt random (bcrypt.dll)
extern "bcrypt" fn BCryptGenRandom(
    hAlgorithm: ?*anyopaque,
    pbBuffer: [*]u8,
    cbBuffer: u32,
    dwFlags: u32,
) callconv(.winapi) i32;

const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;

/// Generate a random password as printable ASCII.
fn generatePassword(allocator: std.mem.Allocator, len: usize) ![]u8 {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    const buf = try allocator.alloc(u8, len);
    var rnd: [128]u8 = undefined;
    const r = BCryptGenRandom(null, &rnd, rnd.len, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (r != 0) return error.RandomFailed;
    var ri: usize = 0;
    for (buf) |*b| {
        if (ri >= rnd.len) {
            const r2 = BCryptGenRandom(null, &rnd, rnd.len, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
            if (r2 != 0) return error.RandomFailed;
            ri = 0;
        }
        b.* = chars[rnd[ri] % chars.len];
        ri += 1;
    }
    return buf;
}

/// Convert an ASCII/UTF-8 string to a NUL-terminated UTF-16 buffer.
fn toUtf16(allocator: std.mem.Allocator, s: []const u8) ![:0]u16 {
    const buf = try allocator.allocSentinel(u16, s.len + 1, 0);
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        buf[i] = s[i];
    }
    buf[s.len] = 0;
    return buf[0..s.len :0];
}

/// Create a sandbox account (idempotent — NERR_UserExists is OK).
/// Returns the generated password (caller frees).
pub fn createSandboxAccount(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    const password = try generatePassword(allocator, 32);
    errdefer allocator.free(password);

    const name_w = try toUtf16(allocator, name);
    defer allocator.free(name_w);
    const pwd_w = try toUtf16(allocator, password);
    defer allocator.free(pwd_w);

    var info = USER_INFO_1{
        .usri1_name = name_w.ptr,
        .usri1_password = pwd_w.ptr,
        .usri1_password_age = 0,
        .usri1_priv = USER_PRIV_USER,
        .usri1_home_dir = null,
        .usri1_comment = null,
        .usri1_flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD,
        .usri1_script_path = null,
    };
    var parm_err: u32 = 0;
    const status = NetUserAdd(null, 1, &info, &parm_err);
    if (status == NERR_Success) {
        return password;
    }
    if (status == NERR_UserExists) {
        // Account exists (from a prior setup): update its password so the
        // DPAPI-stored password stays in sync with the account. Otherwise a
        // fresh random password is generated but never applied, and later
        // LogonUserW fails.
        const pwd1003 = USER_INFO_1003{ .usri1003_password = pwd_w.ptr };
        const set = NetUserSetInfo(null, name_w.ptr, 1003, &pwd1003, &parm_err);
        if (set != 0) return error.NetUserSetInfoFailed;
        return password;
    }
    return error.NetUserAddFailed;
}

/// Encrypt the password with DPAPI (per-user scope) and write to file.
/// Returns the encrypted blob (caller frees).
pub fn dpapiProtect(allocator: std.mem.Allocator, password: []const u8) ![]u8 {
    var in = DATA_BLOB{ .cbData = @intCast(password.len), .pbData = @constCast(password.ptr) };
    var out: DATA_BLOB = undefined;
    const ok = CryptProtectData(&in, null, null, null, null, 0, &out);
    if (ok == 0) return error.CryptProtectFailed;
    defer _ = LocalFree(@ptrCast(out.pbData));
    const result = try allocator.dupe(u8, out.pbData.?[0..out.cbData]);
    return result;
}

/// Decrypt a DPAPI blob back to the password.
pub fn dpapiUnprotect(allocator: std.mem.Allocator, blob: []const u8) ![]u8 {
    var in = DATA_BLOB{ .cbData = @intCast(blob.len), .pbData = @constCast(blob.ptr) };
    var out: DATA_BLOB = undefined;
    const ok = CryptUnprotectData(&in, null, null, null, null, 0, &out);
    if (ok == 0) return error.CryptUnprotectFailed;
    defer _ = LocalFree(@ptrCast(out.pbData));
    const result = try allocator.dupe(u8, out.pbData.?[0..out.cbData]);
    return result;
}

/// Delete a sandbox account (cleanup).
pub fn deleteSandboxAccount(allocator: std.mem.Allocator, name: []const u8) !void {
    const name_w = try toUtf16(allocator, name);
    defer allocator.free(name_w);
    _ = NetUserDel(null, name_w.ptr);
}

// ---- Tests ----

const testing = std.testing;

test "passwordFileFor maps account names to distinct password files" {
    try testing.expectEqualStrings(SANDBOX_ACCOUNT_ONLINE_PASSWORD_FILE, passwordFileFor(SANDBOX_ACCOUNT_ONLINE));
    try testing.expectEqualStrings(SANDBOX_ACCOUNT_OFFLINE_PASSWORD_FILE, passwordFileFor(SANDBOX_ACCOUNT_OFFLINE));
    try testing.expectEqualStrings(SANDBOX_ACCOUNT_PASSWORD_FILE, passwordFileFor("unknown-account"));
}

test "toUtf16 converts ascii" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const w = try toUtf16(arena.allocator(), "abc");
    try testing.expectEqualSlices(u16, &[_]u16{ 'a', 'b', 'c' }, w[0..3]);
    try testing.expectEqual(@as(u16, 0), w[3]);
}

test "generatePassword produces printable ascii of expected length" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const pwd = try generatePassword(arena.allocator(), 32);
    try testing.expectEqual(@as(usize, 32), pwd.len);
    for (pwd) |c| {
        try testing.expect(c >= 33 and c <= 126);
    }
}

test "dpapi roundtrip" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const secret = "s3cr3t-pass";
    const blob = try dpapiProtect(arena.allocator(), secret);
    const decrypted = try dpapiUnprotect(arena.allocator(), blob);
    try testing.expectEqualStrings(secret, decrypted);
}
