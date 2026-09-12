# Operating protocol

The stage context already contains the Run root and operations index; do not load them again. Select the exact start or wait-resume operation resource from current instance/run facts. If no exact instance exists, select `deploying` and follow its instance-creation protocol, then return to `operating` with the owner-issued instance receipt. With an existing instance and execution authorization, invoke the corresponding native tool once and preserve its run receipt. With a terminal result, deliver it or move to `monitoring` only for requested evidence detail.
