import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("SV2 API coverage inventory is complete and matches the live v3 catalog", () => {
  const raw = execFileSync(
    process.execPath,
    [path.resolve("scripts", "check-api-coverage.mjs"), "--json"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(raw) as {
    readonly officialClassCount: number;
    readonly officialMethodCount: number;
    readonly liveActionCount: number;
    readonly classifiedActionCount: number;
    readonly semanticWriteCount: number;
    readonly errors: readonly string[];
  };

  assert.deepEqual(result.errors, []);
  assert.equal(result.officialClassCount, 23);
  assert.ok(result.officialMethodCount >= 280);
  assert.equal(result.classifiedActionCount, result.liveActionCount);
  assert.ok(result.semanticWriteCount >= 30);
});
