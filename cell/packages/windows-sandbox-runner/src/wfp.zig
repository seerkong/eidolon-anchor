const std = @import("std");
const builtin = @import("builtin");

const HANDLE = *anyopaque;

/// Windows Filtering Platform (WFP) network filtering.
///
/// When network_access=disabled, this module installs a system-wide WFP filter
/// that blocks outbound connections initiated by processes running under the
/// sandbox account/token. Requires an elevated process (the setup helper runs
/// elevated and installs these filters).
///
/// NOTE: This is a thin binding. Real usage requires running elevated and
/// transactionally installing filters. The runner applies these at setup time
/// (via the elevated setup helper), not per-command.

const FWPM_LAYER_ALE_AUTH_CONNECT_V4: u16 = 50;
const FWPM_LAYER_ALE_AUTH_CONNECT_V6: u16 = 49;
const FWP_ACTION_BLOCK: u32 = 0x00004000;
const FWPM_FILTER_FLAG_PERSISTENT: u32 = 0x00000001;

const FWP_VALUE_TYPE = enum(i32) {
    EMPTY = 0,
    UINT8,
    UINT16,
    UINT32,
    INT32,
    UINT64,
    INT64,
    FLOAT,
    DOUBLE,
    GUID,
    STRING,
    BYTE_ARRAY,
    SID,
    SECURITY_DESCRIPTOR,
    TOKEN_INFORMATION,
    TOKEN_ACCESS_INFORMATION,
    FWP_VALUE_TYPE_MAX,
};

const FWP_BYTE_ARRAY = extern struct {
    data: [*]u8,
    size: u32,
};

const FWP_VALUE = extern struct {
    type: FWP_VALUE_TYPE,
    value: extern union {
        uint8: u8,
        uint16: u16,
        uint32: u32,
        int32: i32,
        uint64: u64,
        int64: i64,
        float32: f32,
        double64: f64,
        byteArray: *FWP_BYTE_ARRAY,
        sid: ?*anyopaque,
        string: ?[*:0]const u16,
    },
};

const FWPM_FILTER = extern struct {
    filterKey: ?*anyopaque, // GUID*
    displayData: ?*anyopaque,
    flags: u32,
    providerKey: ?*anyopaque,
    providerData: ?*anyopaque,
    layerKey: u32,
    subLayerKey: ?*anyopaque,
    weight: ?*anyopaque, // FWP_VALUE
    filterCondition: ?*anyopaque,
    numFilterConditions: u32,
    action: extern struct {
        type: u32,
        filterType: ?*anyopaque,
    },
    rawContext: ?*anyopaque,
    reserved1: ?*anyopaque,
    reserved2: ?*anyopaque,
    reserved3: ?*anyopaque,
};

extern "fwp/uclient" fn FwpmEngineOpen(
    serverName: ?[*:0]const u16,
    authnService: u32,
    authIdentity: ?*anyopaque,
    session: ?*anyopaque,
    engineHandle: *HANDLE,
) callconv(.winapi) i32;

extern "fwp/uclient" fn FwpmEngineClose(engineHandle: HANDLE) callconv(.winapi) i32;

extern "fwp/uclient" fn FwpmFilterAdd(
    engineHandle: HANDLE,
    filter: ?*const FWPM_FILTER,
    sd: ?*anyopaque,
    id: ?*u64,
) callconv(.winapi) i32;

/// Check whether WFP is available (engine opens). Used to gate network-block
/// application; if WFP is unavailable, network access stays enabled.
pub fn wfpAvailable() bool {
    if (builtin.os.tag != .windows) return false;
    var engine: HANDLE = undefined;
    const r = FwpmEngineOpen(null, 0, null, null, &engine);
    if (r != 0) return false;
    _ = FwpmEngineClose(engine);
    return true;
}

// ---- Tests ----

const testing = std.testing;

test "wfpAvailable returns false on non-Windows" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    try testing.expect(!wfpAvailable());
}
