// DOM 冒烟：用 @vue/compiler-sfc 编译 SFC，打成浏览器 bundle，在 jsdom 中真实挂载，
// 覆盖 bootstrap（种子/迁移）、onMounted、Pinia、模板交互渲染。
import { build } from "esbuild";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";

mkdirSync(".test-tmp", { recursive: true });

const vueSfcPlugin = {
  name: "vue-sfc",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = readFileSync(args.path, "utf8");
      const { descriptor } = parse(source, { filename: args.path });
      const id = args.path.replace(/[^a-z0-9]/gi, "");
      const script = compileScript(descriptor, { id });
      const tpl = compileTemplate({
        id,
        filename: args.path,
        source: descriptor.template.content,
        compilerOptions: { bindingMetadata: script.bindings }
      });
      const tplCode = tpl.code.replace(
        /^import\s*\{([^}]*)\}\s*from\s*["']vue["'];?/m,
        (_, names) =>
          names
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
              const [imported, local] = part.split(/\s+as\s+/).map((x) => x.trim());
              return `const ${local ?? imported} = __vue.${imported};`;
            })
            .join("\n")
      );
      let code = script.content.replace(
        /export default[^\n]*_defineComponent\(\s*\{/,
        (m) => `${m}\n  get render() { return __render; },`
      );
      code = `import * as __vue from "vue";\n${code}\n${tplCode}\nconst __render = render;\n`;
      return { contents: code, loader: "ts", resolveDir: new URL(".", pathToFileURL(args.path)).pathname };
    });
  }
};

const entry = `
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "${process.cwd()}/src/App.vue";
const app = createApp(App);
app.use(createPinia());
app.mount("#root");
`;
writeFileSync(".test-tmp/dom-entry.ts", entry);

await build({
  entryPoints: [".test-tmp/dom-entry.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: ".test-tmp/dom.js",
  plugins: [vueSfcPlugin],
  logLevel: "silent"
});

let failures = 0;
function check(name, ok) {
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}`);
  if (!ok) failures += 1;
}

function makeDom(seedStorage = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  // jsdom 自带 Storage；用预置数据初始化
  for (const [k, v] of Object.entries(seedStorage)) window.localStorage.setItem(k, v);
  window.queueMicrotask = queueMicrotask;
  window.structuredClone = globalThis.structuredClone;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.localStorage = window.localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  return dom;
}

const bundleCode = readFileSync(".test-tmp/dom.js", "utf8");

// ---------- 全新环境 ----------
console.log("DOM 挂载：全新环境");
{
  const dom = makeDom();
  dom.window.eval(bundleCode);
  const doc = dom.window.document;
  await new Promise((r) => setTimeout(r, 50));
  const body = doc.body.textContent;
  check("标题渲染", body.includes("油品配送调度台"));
  check("车队面板渲染", body.includes("车队罐容占用台"));
  check("种子配送单渲染", body.includes("城东站"));
  check("冲突草稿框渲染", body.includes("保留为草稿"));
  check("已预占条渲染", body.includes("已预占"));
  check("在途占用条渲染", body.includes("已占用（在途）"));
  check("汇总指标渲染", body.includes("待装车预占"));
  check("台账已写入 localStorage", !!dom.window.localStorage.getItem("hxwlfront-19-oil-dispatch-ledger-v2"));

  // 交互：点击第一张待发车单的"撤单并释放"
  const buttons = [...doc.querySelectorAll("button")];
  const cancelBtn = buttons.find((b) => b.textContent.includes("撤单并释放"));
  check("找到撤单按钮", !!cancelBtn);
  cancelBtn?.click();
  await new Promise((r) => setTimeout(r, 80));
  check("撤单提示出现", doc.body.textContent.includes("已撤单，车辆与罐容占用已释放"));
  check("出现已撤单状态", doc.body.textContent.includes("已撤单"));
  dom.window.close();
}

// ---------- 旧数据迁移 ----------
console.log("\nDOM 挂载：v1 旧台账迁移");
{
  const legacy = [
    { id: "mig-1", station: "机场站", fuel: "柴油", tons: 7, arriveAt: "2026-07-09", status: "待发车", notes: "迁移冒烟单", createdAt: new Date().toISOString() }
  ];
  const dom = makeDom({ "hxwlfront-19-oil-delivery": JSON.stringify(legacy) });
  dom.window.eval(bundleCode);
  await new Promise((r) => setTimeout(r, 50));
  const body = dom.window.document.body.textContent;
  check("迁移成功提示", body.includes("旧台账迁移完成"));
  check("旧单内容渲染", body.includes("迁移冒烟单"));
  check("迁移标记渲染", body.includes("旧台账迁移单"));
  check("迁移闸门已置", dom.window.localStorage.getItem("hxwlfront-19-oil-dispatch-migrated-v2") === "1");

  // 重新加载（模拟重开）：不应再提示迁移、不应重复
  const dom2 = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  for (let i = 0; i < dom.window.localStorage.length; i += 1) {
    const k = dom.window.localStorage.key(i);
    dom2.window.localStorage.setItem(k, dom.window.localStorage.getItem(k));
  }
  dom2.window.eval(bundleCode);
  await new Promise((r) => setTimeout(r, 50));
  const body2 = dom2.window.document.body.textContent;
  check("重开不再提示迁移", !body2.includes("旧台账迁移完成"));
  check("重开后旧单仍在且只有一张", body2.match(/迁移冒烟单/g)?.length === 1);
  check("旧 key 原始数据保留", !!dom2.window.localStorage.getItem("hxwlfront-19-oil-delivery"));
  dom.window.close();
  dom2.window.close();
}

console.log(failures === 0 ? "\nDOM 冒烟全部通过" : `\n${failures} 项失败`);
process.exit(failures ? 1 : 0);
