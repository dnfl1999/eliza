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
  "plugins/plugin-browser/quint/DescendantActivation.qnt",
);
if (
  process.argv.length > 3 ||
  (process.argv[2] && path.resolve(root, process.argv[2]) !== model)
) {
  throw new Error("Activation conformance requires its own model");
}
const outputRoot = testOutputPath("quint-descendantactivation");
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
assert.ok(assertions.length >= 9, "Missing real-code tests");
assert.ok(
  assertions.every((test) => test.status === "passed"),
  "Skipped or failed implementation test",
);
const expected = [
  "activates a clicked descendant through its link control without extra requests",
  "activates a clicked descendant through its link-nested control without extra requests",
  "activates a clicked descendant through its link-svg control without extra requests",
  "activates a clicked descendant through its submit control without extra requests",
  "activates a clicked descendant through its submit-nested control without extra requests",
  "activates a clicked descendant through its submit-svg control without extra requests",
  "activates a clicked descendant through its disabled control without extra requests",
  "activates a clicked descendant through its disabled-fieldset control without extra requests",
  "activates a clicked descendant through its plain control without extra requests",
];
const actual = assertions
  .filter((test) =>
    test.title.startsWith("activates a clicked descendant through its "),
  )
  .map((test) => test.title);
assert.deepEqual(
  actual.sort(),
  expected.sort(),
  "Model fixture cases drifted from implementation tests",
);
console.log(
  `DescendantActivation implementation conformance passed. Report ${report}`,
);
