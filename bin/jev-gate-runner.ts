import { parseGateArgs, evaluateGate, printHelp, GateStateError, type GateOptions } from "../src/gate.js";
import { JevClient } from "../src/jev.js";

async function main() {
  const args = process.argv.slice(2);
  let options: GateOptions;
  try {
    options = parseGateArgs(args);
  } catch (err: any) {
    // Bad arguments never pass, even with --fail-open: the gate cannot know what was asked.
    console.error(`[jev-gate] ERROR: ${err?.message || err}`);
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    // Only a bare --help is a successful run; mixed into a gate invocation it must not look like a pass.
    process.exit(args.length === 1 ? 0 : 2);
  }

  try {
    const client = new JevClient();
    const result = await evaluateGate(options, client);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const probStr = (result.probability * 100).toFixed(1) + "%";
      const threshStr = (result.threshold * 100).toFixed(1) + "%";
      if (result.passed) {
        console.log(`[jev-gate] PASS: P=${probStr} >= ${threshStr} (${result.elapsedMs}ms)`);
        console.log(`Criteria: "${result.criteria}"`);
      } else {
        console.error(`[jev-gate] FAIL: P=${probStr} < ${threshStr} (${result.elapsedMs}ms)`);
        console.error(`Criteria: "${result.criteria}"`);
      }
    }

    process.exit(result.passed ? 0 : 1);
  } catch (err: any) {
    if (options.failOpen && !(err instanceof GateStateError)) {
      console.warn(`[jev-gate] WARN (fail-open): ${err?.message || err}`);
      process.exit(0);
    }
    if (options.json) {
      console.error(JSON.stringify({ error: err?.message || String(err), passed: false }, null, 2));
    } else {
      console.error(`[jev-gate] ERROR: ${err?.message || err}`);
    }
    process.exit(2);
  }
}

main();
