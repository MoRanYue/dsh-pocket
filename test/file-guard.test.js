// 移动端文件辅助（issue #17）：早期在捕获阶段拦截文件链接并弹「手机上无法直接打开
// 电脑上的文件」；DSH 改成在侧边栏预览文件后这层拦截已删除（它会把文案像路径的正常
// 按钮一起吞掉）。现在只剩「复制」按钮注入 + 隐藏「添加工作区」入口。
// 测试只验证「接线 + 识别方式不依赖 hash 类名 + 不再拦截点击 + 打包产物含逻辑 +
// CSS 隐藏入口」，与 mobile-nav.test.js 同风格（不引 jsdom，读源码/产物断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client/mobile/fileGuard.ts', import.meta.url), 'utf8');
const apply = readFileSync(new URL('../client/mobile/mobile-apply.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/mobile/mobile.css.ts', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('fileGuard 只依赖稳定结构（button/a + 路径文案），不依赖 hash 类名', () => {
  assert.ok(src.includes("querySelectorAll('button, a')"), '必须用 querySelectorAll("button, a") 找文件链接');
  assert.ok(src.includes('looksLikeFilePath'), '必须用语义化路径检测，而非按类名');
  // hash 类名形如 [class$="_xxx"]；检测逻辑里绝不能出现按类名的属性选择器
  assert.ok(!/\[class[*^$]?=/.test(src), 'fileGuard.ts 的检测不能出现 class 属性选择器（hash 类名每次构建都变）');
});

test('不再拦截文件链接的点击（DSH 现在在侧边栏预览文件，拦截会让链接点不动）', () => {
  // 曾经的守卫：document 捕获阶段 click → preventDefault + stopImmediatePropagation + 弹提示。
  // DSH 的文件链接改走 openFile（→ chat inject → 侧边栏预览），不再调主机 openPath，
  // 因此这层拦截只会把正常点击吞掉。
  assert.ok(!src.includes('stopImmediatePropagation'), '不能再用 stopImmediatePropagation 掐断事件');
  assert.ok(!/document\.addEventListener\(\s*['"]click['"]/.test(src), '不能在 document 上挂 click 拦截');
  assert.ok(!src.includes('手机上无法直接打开电脑上的文件'), '过时的「无法打开」提示文案必须删掉');
  // 复制按钮自己的 handler 仍然允许 preventDefault（它自己就是按钮，不是拦截别人）
  assert.ok(!/const onClick\b/.test(src), '不应再有文件链接的 onClick 拦截函数');
});

test('mobile-apply 已接线 startFileGuard（窄屏生效、传入 readFile，且不再接 fileCopy）', () => {
  assert.ok(apply.includes("import { startFileGuard } from './fileGuard.ts'"), '必须 import 模块');
  assert.ok(apply.includes('startFileGuard(readFile)'), '必须调用 startFileGuard 并传入 readFile 回调');
  assert.ok(apply.includes('POCKET_ENDPOINTS.fileRead'), 'readFile 回调必须打到 fileRead 端点');
  assert.ok(apply.includes('getWorkspaceCwd()'), 'readFile 必须携带工作区 cwd 以精确解析相对路径');
  assert.ok(apply.includes("'dsh-mobile-nav: file copy button + hide add-workspace (issue #17)'"), 'effect 标签应标注 issue #17');
  assert.ok(apply.includes('if (!narrow.matches) return'), 'effect 必须受 narrow 门控');
  assert.ok(!apply.includes('startFileCopyInjection'), '不应再引用已删除的复制按钮模块');
});

test('源码含「添加工作区」隐藏文案（产物会被 esbuild 转义，故查源码）', () => {
  // 中英双语隐藏标签
  assert.ok(src.includes('添加工作区') && src.includes('Add workspace'), '必须覆盖中英双语的添加工作区入口');
});

test('打包产物含复制按钮 + 隐藏添加工作区的结构标记', () => {
  // esbuild 会把单引号规范成双引号、中文转义成 \\uXXXX，故只查 ASCII 结构标记。
  assert.ok(/querySelectorAll\(\s*["']button, a["']\s*\)/.test(bundle), '产物必须保留 querySelectorAll("button, a") 检测——先跑 node client/build.mjs');
  assert.ok(bundle.includes('file-guard-toast'), '产物必须含 toast 标记');
  assert.ok(bundle.includes('add-workspace'), '产物必须含隐藏添加工作区的逻辑');
  // 复制按钮：注入标记 + 经 RPC 读文件（data-mobile-nav-copy 标记已处理链接，避免重复注入）
  assert.ok(bundle.includes('copy-file'), '产物必须含复制按钮标记 data-mobile-nav="copy-file"');
  assert.ok(bundle.includes('data-mobile-nav-copy'), '产物必须用标记避免重复注入复制按钮');
});

test('CSS 隐藏「添加工作区」图标 + 复制按钮样式（窄屏）', () => {
  assert.ok(css.includes('button[aria-label="添加工作区"]'), 'mobile.css.ts 必须隐藏 zh 添加工作区按钮');
  assert.ok(css.includes('button[aria-label="Add workspace"]'), 'mobile.css.ts 必须隐藏 en 添加工作区按钮');
  // 复制按钮样式必须存在（窄屏才注入/显示）
  assert.ok(css.includes('[data-mobile-nav="copy-file"]'), 'mobile.css.ts 必须含复制按钮样式');
});
