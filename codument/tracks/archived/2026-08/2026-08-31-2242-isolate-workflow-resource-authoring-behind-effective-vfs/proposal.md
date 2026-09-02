# Isolate Workflow resource authoring behind Effective VFS

## Problem

Production terminal metadata contains an admitted Effective Eidolon VFS and compatibility `global` / `workspace` physical ResourcePackage layers at the same time. Registry projection selects Effective VFS, but `WorkflowComponent` still retains the physical layers, feeds them into its authoring session and constructs `WorkflowResourcePackagePublisher`. That publisher validates and atomically replaces the physical workspace ResourcePackage tree, leaving a second mutation/validation authority in the same production component.

The durable Workflow architecture Behavior also still describes separately injected physical ResourcePackage layers as the normal shared product topology.

## Goal

When Effective VFS is configured, Workflow composition must expose only the revision-bound Effective VFS registry/read path and its explicit Effective-VFS authoring port. Physical ResourcePackage layers and `WorkflowResourcePackagePublisher` must be unavailable. When Effective VFS is absent, the existing physical-only compatibility path remains usable.

The Behavior correction must be promoted through this Track's BehaviorPatch/archive lifecycle.

## Scope

- Add a production-shaped regression with Effective VFS and physical metadata present together.
- Make `WorkflowComponent` derive one mutually exclusive resource authority mode.
- Prevent caller-supplied physical publisher/layers from remaining active in Effective-VFS mode.
- Preserve workflow-definition authoring under `.eidolon/workflows`; this Track only isolates ResourcePackage authoring.
- Preserve the explicit physical-only compatibility path when no Effective VFS is configured.
- Promote the corrected `explicit-architecture-boundaries` requirement.

## Non-goals

- Rewriting Agent authoring, which already uses the Effective-VFS mutation/admission transaction.
- Removing all legacy compatibility code in this Track.
- Repairing the separately owned provider-context transition conflict.
- Publishing packages to npm.
