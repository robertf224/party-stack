#!/usr/bin/env bash
set -euo pipefail

# Uncached Node tasks can make the Actions stdout pipe non-blocking, causing
# Vite Task's output forwarder to fail with EAGAIN. Only tail touches that pipe.
# https://github.com/voidzero-dev/vite-plus/issues/2824
log_file=$(mktemp "$RUNNER_TEMP/vite-task-ci.XXXXXX")
trap 'rm -f "$log_file"' EXIT

vp run ci >"$log_file" 2>&1 &
task_pid=$!
tail --pid="$task_pid" -n +1 -f "$log_file" &
log_pid=$!

status=0
wait "$task_pid" || status=$?
wait "$log_pid"
exit "$status"
