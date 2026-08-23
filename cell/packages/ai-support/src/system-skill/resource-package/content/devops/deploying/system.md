# Deploying system context

Create an instance and bind explicit inputs/material revisions from an immutable published entrypoint. The stage context already contains the Run Skill root and operation index; do not load them again. Load the exact execution operation resources in one bounded batch.

Deployment binding is a separate fact. It neither edits the definition nor authorizes execution.
