const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // ---- eidolon-windows-sandbox-runner.exe ----
    const runner_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    runner_mod.linkSystemLibrary("advapi32", .{});
    runner_mod.linkSystemLibrary("kernel32", .{});
    runner_mod.linkSystemLibrary("shell32", .{});
    const runner = b.addExecutable(.{
        .name = "eidolon-windows-sandbox-runner",
        .root_module = runner_mod,
    });
    b.installArtifact(runner);

    // ---- eidolon-windows-sandbox-setup.exe ----
    const setup_mod = b.createModule(.{
        .root_source_file = b.path("src/setup.zig"),
        .target = target,
        .optimize = optimize,
    });
    setup_mod.linkSystemLibrary("advapi32", .{});
    setup_mod.linkSystemLibrary("shell32", .{});
    setup_mod.linkSystemLibrary("kernel32", .{});
    const setup = b.addExecutable(.{
        .name = "eidolon-windows-sandbox-setup",
        .root_module = setup_mod,
    });
    b.installArtifact(setup);

    // ---- token.zig unit tests ----
    const token_mod = b.createModule(.{
        .root_source_file = b.path("src/token.zig"),
        .target = target,
        .optimize = optimize,
    });
    token_mod.linkSystemLibrary("advapi32", .{});
    token_mod.linkSystemLibrary("kernel32", .{});
    const token_tests = b.addTest(.{ .root_module = token_mod });
    const run_token_tests = b.addRunArtifact(token_tests);
    b.step("test", "Run token.zig unit tests").dependOn(&run_token_tests.step);

    // ---- acl.zig unit tests ----
    const acl_mod = b.createModule(.{
        .root_source_file = b.path("src/acl.zig"),
        .target = target,
        .optimize = optimize,
    });
    acl_mod.linkSystemLibrary("advapi32", .{});
    acl_mod.linkSystemLibrary("kernel32", .{});
    const acl_tests = b.addTest(.{ .root_module = acl_mod });
    const run_acl_tests = b.addRunArtifact(acl_tests);
    b.step("test-acl", "Run acl.zig unit tests").dependOn(&run_acl_tests.step);

    // ---- wfp.zig unit tests ----
    const wfp_mod = b.createModule(.{
        .root_source_file = b.path("src/wfp.zig"),
        .target = target,
        .optimize = optimize,
    });
    wfp_mod.linkSystemLibrary("fwpuclnt", .{});
    const wfp_tests = b.addTest(.{ .root_module = wfp_mod });
    const run_wfp_tests = b.addRunArtifact(wfp_tests);
    b.step("test-wfp", "Run wfp.zig unit tests").dependOn(&run_wfp_tests.step);
}
