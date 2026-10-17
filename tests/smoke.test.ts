import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

for (const response of ["empty", "valid"]) {
  test(`模型联调脚本：${response === "valid" ? "有效响应成功" : "空响应以非零状态退出"}`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", path.resolve("tests/fixtures/smoke-transport.mjs"), "scripts/deepseek-smoke.ts"], { encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "smoke-sentinel-not-real", SMOKE_RESPONSE: response }, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, response === "valid" ? 0 : 1, result.stderr);
    if (response === "valid") assert.match(result.stdout, /"compatible": true/);
    else assert.match(result.stderr, /预期返回 OK/);
  });
}
