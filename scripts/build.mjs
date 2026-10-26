import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_NAME = "siyuan-latex-paste";
const watch = process.argv.includes("--watch");

/** 读取 .env 里的 SIYUAN_WORKSPACE，方便构建产物直接落到工作区 */
function readWorkspace() {
  if (process.env.SIYUAN_WORKSPACE) {
    return process.env.SIYUAN_WORKSPACE;
  }
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    return "";
  }
  const line = fs
    .readFileSync(envPath, "utf-8")
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith("SIYUAN_WORKSPACE"));
  if (!line) {
    return "";
  }
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

const workspace = readWorkspace();
// dist 是权威产物（测试也读它），工作区只是同步目标，
// 两边都写可以避免「改了源码却拿旧产物验证」这种坑。
const outdir = path.join(root, "dist");
const syncDir = workspace ? path.join(workspace, "data", "plugins", PLUGIN_NAME) : "";

/** 静态资源：清单、图标、预览图、i18n */
function copyStatic(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // index.css 是集市硬性要求，就算插件不用样式也得有
  const files = [
    "plugin.json",
    "index.css",
    "icon.png",
    "preview.png",
    "README.md",
    "README.zh-CN.md",
  ];
  for (const file of files) {
    const source = path.join(root, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(dir, file));
    }
  }
  const i18nDir = path.join(root, "src", "i18n");
  if (fs.existsSync(i18nDir)) {
    const target = path.join(dir, "i18n");
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(i18nDir)) {
      fs.copyFileSync(path.join(i18nDir, file), path.join(target, file));
    }
  }
}

/**
 * 把 dist 整体同步到思源工作区。
 * 这里没用 fs.cpSync —— 在某些盘符（本机 D:）上它会让进程直接崩掉且没有任何报错，
 * 老老实实手动递归复制更稳。
 */
function syncToWorkspace() {
  fs.rmSync(syncDir, { recursive: true, force: true });
  copyDir(outdir, syncDir);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

const options = {
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16"],
  outfile: path.join(outdir, "index.js"),
  external: ["siyuan"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

/**
 * watch 模式下每次重建都要同步。
 *
 * 之前只在启动时同步了一次，之后 esbuild 反复重写 dist/index.js，
 * 工作区里却一直是启动时那份 —— 改了源码、在思源里刷新，看到的还是旧版本。
 */
const syncOnRebuild = {
  name: "sync-workspace",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        return;
      }
      try {
        // 静态文件也重拷一遍：改 plugin.json / i18n 时同样要同步过去
        copyStatic(outdir);
        syncToWorkspace();
        console.log(`[sync] ${new Date().toLocaleTimeString()} → ${syncDir}`);
      } catch (error) {
        console.error("[sync] 同步到工作区失败", error);
      }
    });
  },
};

if (watch && syncDir) {
  options.plugins = [syncOnRebuild];
}

copyStatic(outdir);

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`\nWatching... output: ${outdir}`);
  if (syncDir) {
    console.log(`同步目录: ${syncDir}`);
  }
  console.log("改动源码后会自动重新构建并同步，在思源里刷新插件即可看到效果。\n");
} else {
  await esbuild.build(options);
  if (syncDir) {
    syncToWorkspace();
    console.log(`\nBuild done: ${outdir}\n已同步到: ${syncDir}`);
  } else {
    console.log(`\nBuild done: ${outdir}`);
    console.log("提示：在 .env 里设置 SIYUAN_WORKSPACE，可让构建产物自动同步到思源工作区的 data/plugins 下。");
  }
}
