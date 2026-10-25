import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DirectoryPicker } from "../lib/server/directory-picker";

const display = { DISPLAY: ":test" };
const signal = () => new AbortController().signal;
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

test("系统目录选择：中文、空格路径原样作为参数传递，无效初始目录回退主目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  try {
    const selected = path.join(root, " 中文 项目 ");
    await mkdir(selected);
    const calls: string[][] = [];
    const picker = new DirectoryPicker(async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: selected + "\n", stderr: "" };
    }, display, root);
    assert.equal(await picker.pick(selected, signal()), await realpath(selected));
    assert.equal(calls[0].at(-1), `--filename=${selected}/`);
    await picker.pick("/nonexistent-picker-directory", signal());
    assert.equal(calls[1].at(-1), `--filename=${await realpath(root)}/`);
    await picker.pick("relative/path", signal());
    assert.equal(calls[2].at(-1), calls[1].at(-1));
    const file = path.join(root, "file");
    await writeFile(file, "text");
    await picker.pick(file, signal());
    assert.equal(calls[3].at(-1), calls[1].at(-1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("系统目录选择：缺少 Zenity 时使用 KDialog；取消及重复使用正常收束", async () => {
  const calls: string[] = [];
  const picker = new DirectoryPicker(async (file) => {
    calls.push(file);
    if (file === "zenity") throw missing();
    return { code: 1, stdout: "", stderr: "" };
  }, display, tmpdir());
  assert.equal(await picker.pick("", signal()), null);
  assert.equal(await picker.pick("", signal()), null);
  assert.deepEqual(calls, ["zenity", "kdialog", "zenity", "kdialog"]);
});

test("系统目录选择：工具缺失、图形会话缺失、运行失败及非法结果均有明确错误", async () => {
  await assert.rejects(new DirectoryPicker(async () => { throw missing(); }, display).pick("", signal()), /未安装/);
  await assert.rejects(new DirectoryPicker(async () => { throw Error("must not run"); }, {}).pick("", signal()), /图形会话/);
  await assert.rejects(new DirectoryPicker(async () => { throw Error("spawn failed"); }, display).pick("", signal()), /无法打开/);
  await assert.rejects(new DirectoryPicker(async () => ({ code: 1, stdout: "", stderr: "cannot open display" }), display).pick("", signal()), /启动或运行失败/);
  await assert.rejects(new DirectoryPicker(async () => ({ code: 0, stdout: "/nonexistent-picker-result\n", stderr: "" }), display).pick("", signal()), /所选目录不可访问/);
});

test("系统目录选择：并发被拒绝，请求中止传递给进程且释放窗口锁", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  const picker = new DirectoryPicker(async (_file, _args, requestSignal) => {
    assert.equal(requestSignal, controller.signal);
    started();
    return new Promise((_resolve, reject) => {
      requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }, display);
  const first = picker.pick("", controller.signal);
  await ready;
  await assert.rejects(picker.pick("", signal()), /窗口已打开/);
  controller.abort();
  assert.equal(await first, null);
  assert.equal(await picker.pick("", controller.signal), null);
});
