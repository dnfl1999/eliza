/** Bind the finite activation cases to the existing real HTTP command tests. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(
  root,
  "plugins/plugin-browser/quint/KeyboardActivation.qnt",
);
if (
  process.argv.length > 3 ||
  (process.argv[2] && path.resolve(root, process.argv[2]) !== model)
) {
  throw new Error("Activation conformance requires its own model");
}
const outputRoot = testOutputPath("quint-keyboardactivation");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "run-"));
const report = path.join(output, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    "--conditions=eliza-source",
    "--import",
    new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    path.join(root, "plugins/plugin-browser/node_modules/vitest/vitest.mjs"),
    "run",
    "src/workspace/__tests__/browser-workspace-web-real-code.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    "--outputFile",
    report,
  ],
  {
    cwd: path.join(root, "plugins/plugin-browser"),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(output, "command.log"),
  (result.stdout ?? "") + (result.stderr ?? ""),
);
assert.ifError(result.error);
assert.equal(result.signal, null);
assert.equal(
  result.status,
  0,
  `Real HTTP implementation tests failed; see ${output}`,
);
const data = JSON.parse(readFileSync(report, "utf8"));
assert.equal(data.success, true);
const assertions = data.testResults.flatMap((suite) => suite.assertionResults);
assert.ok(assertions.length >= 10, "Missing real-code tests");
assert.ok(
  assertions.every((test) => test.status === "passed"),
  "Skipped or failed implementation test",
);
const expected = [
  "activates link with Enter through the keyboard command",
  "activates link with Space through the keyboard command",
  "activates submit with Space through the keyboard command",
  "activates submit with Enter through the keyboard command",
  "activates input-submit with Space through the keyboard command",
  "activates ordinary with Space through the keyboard command",
  "activates reset with Space through the keyboard command",
  "activates disabled with Space through the keyboard command",
  "activates fieldset-disabled with Space through the keyboard command",
  "activates plain with Enter through the keyboard command",
];
const actual = assertions
  .filter((test) => test.title.startsWith("activates "))
  .map((test) => test.title);
assert.deepEqual(
  actual.sort(),
  expected.sort(),
  "Model fixture cases drifted from implementation tests",
);
console.log(
  `KeyboardActivation implementation conformance passed. Report ${report}`,
);
