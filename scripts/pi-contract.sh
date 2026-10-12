#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/pi-verify-source.mjs
node scripts/pi-hydrate.mjs
cd vendor/pi/packages/coding-agent
PI_OFFLINE=1 node ../../node_modules/vitest/vitest.mjs run \
  test/rpc-prompt-response-semantics.test.ts \
  test/rpc-jsonl.test.ts \
  test/suite/regressions/6363-agent-settled-event.test.ts \
  test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts

cd ../agent
PI_OFFLINE=1 node ../../node_modules/vitest/vitest.mjs run test/agent-loop.test.ts --testNamePattern 'should inject queued messages after all tool calls complete|should force sequential execution when a tool has executionMode=sequential even with default parallel config|should allow parallel execution when all tools have executionMode=parallel|should emit tool_execution_end in completion order but persist tool results in source order'
