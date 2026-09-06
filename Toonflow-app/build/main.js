"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/main.ts
var import_electron = require("electron");
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
var import_module = __toESM(require("module"));
import_electron.app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
import_electron.app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
var TARGET_ENTRIES = /* @__PURE__ */ new Set(["assets", "models", "serve", "skills", "web", "vendor"]);
function copyDir(src, dest) {
  if (!import_fs.default.existsSync(src)) return;
  import_fs.default.mkdirSync(dest, { recursive: true });
  for (const entry of import_fs.default.readdirSync(src, { withFileTypes: true })) {
    const s = import_path.default.join(src, entry.name);
    const d = import_path.default.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : import_fs.default.existsSync(d) || import_fs.default.copyFileSync(s, d);
  }
}
function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
function initializeData() {
  const srcDir = import_path.default.join(process.resourcesPath, "data");
  const destDir = import_path.default.join(import_electron.app.getPath("userData"), "data");
  const versionFilePath = import_path.default.join(destDir, "version.txt");
  let shouldForceReplace = false;
  if (!import_fs.default.existsSync(versionFilePath)) {
    shouldForceReplace = true;
  } else {
    const localVersion = import_fs.default.readFileSync(versionFilePath, "utf-8").trim();
    if (compareVersions(localVersion, "1.1.8") < 0) {
      shouldForceReplace = true;
    }
  }
  for (const dir of TARGET_ENTRIES) {
    const targetDir = import_path.default.join(destDir, dir);
    if (shouldForceReplace) {
      import_fs.default.rmSync(targetDir, { recursive: true, force: true });
      copyDir(import_path.default.join(srcDir, dir), targetDir);
      continue;
    }
    if (!import_fs.default.existsSync(targetDir)) {
      copyDir(import_path.default.join(srcDir, dir), targetDir);
    }
  }
  if (shouldForceReplace) {
    import_fs.default.mkdirSync(destDir, { recursive: true });
    import_fs.default.writeFileSync(versionFilePath, `${"1.1.8"}
`, "utf-8");
  }
}
function getNodeModulesPaths() {
  const paths = [];
  if (import_electron.app.isPackaged) {
    const unpackedNodeModules = import_path.default.join(process.resourcesPath, "app.asar.unpacked", "node_modules");
    if (import_fs.default.existsSync(unpackedNodeModules)) {
      paths.push(unpackedNodeModules);
    }
    const asarNodeModules = import_path.default.join(process.resourcesPath, "app.asar", "node_modules");
    paths.push(asarNodeModules);
  } else {
    paths.push(import_path.default.join(process.cwd(), "node_modules"));
  }
  return paths;
}
function requireWithCustomPaths(modulePath) {
  const appNodeModulesPaths = getNodeModulesPaths();
  const originalNodeModulePaths = import_module.default._nodeModulePaths;
  import_module.default._nodeModulePaths = function(from) {
    const paths = originalNodeModulePaths.call(this, from);
    for (let i = appNodeModulesPaths.length - 1; i >= 0; i--) {
      const p = appNodeModulesPaths[i];
      if (!paths.includes(p)) {
        paths.unshift(p);
      }
    }
    return paths;
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    import_module.default._nodeModulePaths = originalNodeModulePaths;
  }
}
var mainWindow = null;
function createMainWindow() {
  return new Promise((resolve) => {
    const win = new import_electron.BrowserWindow({
      width: 1e3,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      thickFrame: true
    });
    mainWindow = win;
    win.setMenuBarVisibility(false);
    win.removeMenu();
    win.on("closed", () => {
      mainWindow = null;
    });
    win.once("ready-to-show", () => {
      win.show();
      resolve();
    });
    const isDev = process.env.NODE_ENV === "dev" || !import_electron.app.isPackaged;
    if (process.env.VITE_DEV) {
      void win.loadURL("http://localhost:50188");
    } else {
      const htmlPath = isDev ? import_path.default.join(process.cwd(), "data", "web", "index.html") : import_path.default.join(import_electron.app.getPath("userData"), "data", "web", "index.html");
      void win.loadFile(htmlPath);
    }
  });
}
var closeServeFn;
import_electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: "toonflow",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);
import_electron.app.whenReady().then(async () => {
  try {
    let servePath;
    if (import_electron.app.isPackaged) {
      await new Promise((r) => setTimeout(r, 0));
      initializeData();
      servePath = import_path.default.join(import_electron.app.getPath("userData"), "data", "serve", "app.js");
    } else {
      servePath = import_path.default.join(process.cwd(), "src", "app.ts");
    }
    const mod = requireWithCustomPaths(servePath);
    closeServeFn = mod.closeServe;
    const port = await mod.default(true);
    process.env.PORT = port;
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 2e3);
    });
    import_electron.protocol.handle("toonflow", (request) => {
      const url = new URL(request.url);
      const pathname = url.hostname.toLowerCase();
      const handlers = {
        getappurl: () => ({ url: process.env.URL ?? `http://localhost:${port}/api` }),
        windowminimize: () => {
          mainWindow?.minimize();
          return { ok: true };
        },
        windowmaximize: () => {
          if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
          } else {
            mainWindow?.maximize();
          }
          return { ok: true };
        },
        windowclose: () => {
          import_electron.app.exit(0);
          return { ok: true };
        },
        apprestart: () => {
          setTimeout(() => {
            import_electron.app.relaunch();
            import_electron.app.exit(0);
          }, 500);
          return { ok: true, message: "\u5E94\u7528\u5373\u5C06\u91CD\u542F" };
        },
        windowismaximized: () => ({
          maximized: mainWindow?.isMaximized() ?? false
        }),
        opendevtool: () => {
          mainWindow?.webContents.openDevTools();
          return { ok: true };
        },
        openurlwithbrowser: () => {
          const search = url.searchParams;
          const targetUrl = search.get("url");
          if (targetUrl) {
            const { shell } = require("electron");
            shell.openExternal(targetUrl);
            return { ok: true };
          } else {
            return { ok: false, error: "\u7F3A\u5C11url\u53C2\u6570" };
          }
        },
        getlocallanguage: () => {
          if (process.platform === "darwin") {
            const systemLocale = import_electron.systemPreferences.getUserDefault("AppleLocale", "string");
            return { ok: true, local: systemLocale };
          }
          const appLocale = import_electron.app.getLocale();
          return { ok: true, local: appLocale };
        }
      };
      const handler = handlers[pathname];
      const responseData = handler ? handler() : { error: "\u672A\u77E5\u63A5\u53E3" };
      return new Response(JSON.stringify(responseData), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    });
    await createMainWindow();
  } catch (err) {
    console.error("[\u670D\u52A1\u542F\u52A8\u5931\u8D25]:", err);
    await createMainWindow();
  }
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron.app.quit();
});
import_electron.app.on("activate", () => {
  if (import_electron.BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
import_electron.app.on("before-quit", async (event) => {
  if (closeServeFn) await closeServeFn();
});
