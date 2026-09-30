// 逻辑自测入口：用 esbuild（vite 自带依赖）把 TS 源码与用例打包到临时文件，再交给 node:test 运行
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".cache", "dispatch-test.mjs");

await build({
  entryPoints: [path.join(root, "test", "dispatch.test.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
