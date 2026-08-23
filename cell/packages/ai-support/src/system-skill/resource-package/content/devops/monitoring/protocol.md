# Monitoring protocol

The stage context already contains the Run root and operations index; do not load them again. Load only the exact observe or replay/evidence operation resource needed for the identified `run_id`. Return native status, events, output/error, receipts, and provenance. If evidence reveals a design change, propose an explicit transition to `planning` or `coding`; do not mutate source from this stage.
