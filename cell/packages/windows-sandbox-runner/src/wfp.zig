const std = @import("std");
const builtin = @import("builtin");

const HANDLE = *anyopaque;

/// Windows Filtering Platform (WFP) network filtering.
///
/// When network_access=disabled, the setup helper installs a system-wide WFP
/// filter that blocks outbound connections initiated by processes running under
/// the sandbox account. Requires an elevated process (the setup helper runs
/// elevated and installs these filters).

const FWP_ACTION_BLOCK: u32 = 0x00001001; // FWP_ACTION_FLAG_TERMINATING(0x1000) | 1
const FWPM_FILTER_FLAG_PERSISTENT: u32 = 0x00000001;
const FWP_MATCH_EQUAL: u32 = 0;

const GUID = extern struct {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [8]u8,
};

// Layer / condition keys (real GUIDs from fwpmu.h).
const FWPM_LAYER_ALE_AUTH_CONNECT_V4 = GUID{ .Data1 = 0xc38d57d1, .Data2 = 0x05a7, .Data3 = 0x4c33, .Data4 = .{ 0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82 } };
const FWPM_LAYER_ALE_AUTH_CONNECT_V6 = GUID{ .Data1 = 0x4a72393b, .Data2 = 0x319f, .Data3 = 0x44bc, .Data4 = .{ 0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4 } };
const FWPM_CONDITION_ALE_USER_ID = GUID{ .Data1 = 0xaf043a0a, .Data2 = 0xb34d, .Data3 = 0x4f86, .Data4 = .{ 0x97, 0x9c, 0xc9, 0x03, 0x71, 0xaf, 0x6e, 0x66 } };

const FWPM_DISPLAY_DATA = extern struct {
    name: ?[*:0]const u16,
    description: ?[*:0]const u16,
};

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

const FWPM_ACTION = extern struct {
    type: u32,
    filterType: ?*anyopaque,
};

const FWP_CONDITION = extern struct {
    fieldKey: GUID,
    matchType: u32,
    conditionValue: FWP_VALUE,
};

// FWPM_FILTER0 (fwpmtypes.h) — authoritative layout.
const FWPM_FILTER = extern struct {
    filterKey: GUID,
    displayData: FWPM_DISPLAY_DATA,
    flags: u32,
    providerKey: ?*GUID,
    providerData: FWP_BYTE_ARRAY,
    layerKey: GUID,
    subLayerKey: GUID,
    weight: FWP_VALUE,
    numFilterConditions: u32,
    filterCondition: ?*FWP_CONDITION,
    action: FWPM_ACTION,
    rawContext: ?*anyopaque,
    reserved1: ?*anyopaque,
    reserved2: ?*anyopaque,
    filterId: u64,
    effectiveWeight: FWP_VALUE,
};

extern "fwpuclnt" fn FwpmEngineOpen0(
    serverName: ?[*:0]const u16,
    authnService: u32,
    authIdentity: ?*anyopaque,
    session: ?*anyopaque,
    engineHandle: *HANDLE,
) callconv(.winapi) i32;

extern "fwpuclnt" fn FwpmEngineClose0(engineHandle: HANDLE) callconv(.winapi) i32;

extern "fwpuclnt" fn FwpmFilterAdd0(
    engineHandle: HANDLE,
    filter: ?*const FWPM_FILTER,
    sd: ?*anyopaque,
    id: ?*u64,
) callconv(.winapi) i32;

extern "fwpuclnt" fn FwpmTransactionBegin0(engineHandle: HANDLE, flags: u32) callconv(.winapi) i32;
extern "fwpuclnt" fn FwpmTransactionCommit0(engineHandle: HANDLE) callconv(.winapi) i32;
extern "fwpuclnt" fn FwpmTransactionAbort0(engineHandle: HANDLE) callconv(.winapi) i32;

/// Install a persistent WFP filter that blocks outbound connects for the given
/// user SID. Runs in a transaction; requires an elevated process.
pub fn installOutboundBlockForSid(account_sid: *anyopaque) !void {
    if (builtin.os.tag != .windows) return error.NotWindows;
    var engine: HANDLE = undefined;
    const open = FwpmEngineOpen0(null, 0, null, null, &engine);
    if (open != 0) return error.FwpmEngineOpenFailed;
    defer _ = FwpmEngineClose0(engine);

    const begin = FwpmTransactionBegin0(engine, 0);
    if (begin != 0) return error.FwpmTransactionBeginFailed;
    var committed = false;
    defer {
        if (!committed) _ = FwpmTransactionAbort0(engine);
    }

    // Two filters: IPv4 and IPv6 ALE_AUTH_CONNECT layers, blocking by user SID.
    const layers = [_]GUID{ FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6 };
    for (layers) |layer| {
        var filter = std.mem.zeroes(FWPM_FILTER);
        filter.layerKey = layer;
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
        filter.numFilterConditions = 1;
        var condition = FWP_CONDITION{
            .fieldKey = FWPM_CONDITION_ALE_USER_ID,
            .matchType = FWP_MATCH_EQUAL,
            .conditionValue = .{ .type = .SID, .value = .{ .sid = account_sid } },
        };
        filter.filterCondition = &condition;
        filter.action.type = FWP_ACTION_BLOCK;
        var id: u64 = 0;
        const add = FwpmFilterAdd0(engine, &filter, null, &id);
        if (add != 0) return error.FwpmFilterAddFailed;
    }

    const commit = FwpmTransactionCommit0(engine);
    if (commit != 0) return error.FwpmTransactionCommitFailed;
    committed = true;
}

/// Check whether WFP is available (engine opens). Used to gate network-block
/// application; if WFP is unavailable, network access stays enabled.
pub fn wfpAvailable() bool {
    if (builtin.os.tag != .windows) return false;
    var engine: HANDLE = undefined;
    const r = FwpmEngineOpen0(null, 0, null, null, &engine);
    if (r != 0) return false;
    _ = FwpmEngineClose0(engine);
    return true;
}

// ---- Tests ----

const testing = std.testing;

test "wfpAvailable returns false on non-Windows" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    try testing.expect(!wfpAvailable());
}
