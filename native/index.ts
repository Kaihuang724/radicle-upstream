// Copyright © 2021 The Radicle Upstream Contributors
//
// This file is part of radicle-upstream, distributed under the GPLv3
// with Radicle Linking Exception. For full terms see the included
// LICENSE file.

import { app, type App, ipcMain, dialog, clipboard, shell } from "electron";
import fs from "fs";
import path from "path";
import execa from "execa";
import * as os from "os";

import {
  ProxyProcessManager,
  Options as ProxyProcessOptions,
} from "./proxy-process-manager";
import { MainMessageKind, MainProcess, mainProcessMethods } from "./ipc-types";
import { parseRadicleUrl, throttled } from "./nativeCustomProtocolHandler";
import { openExternalLink, WindowManager } from "./windowManager";
import { config, Config } from "./config";

const isWindows = process.platform === "win32";

// Folder where the companion binaries live
const distBinPath =
  config.environment === "development"
    ? path.join(__dirname, "..", "target", "debug")
    : process.resourcesPath;

// Handle custom protocol on macOS.
app.on("open-url", (event, url) => {
  event.preventDefault();

  const parsedUrl = parseRadicleUrl(url);
  if (parsedUrl) {
    throttled(() => {
      windowManager.sendMessage({
        kind: MainMessageKind.CUSTOM_PROTOCOL_INVOCATION,
        data: { url: parsedUrl },
      });
    });
  }
});

app.on("render-process-gone", (_event, _webContents, details) => {
  if (details.reason !== "clean-exit") {
    console.error(`Electron render process is gone. Reason: ${details.reason}`);
    shutdown();
  }
});

app.on("before-quit", event => {
  windowManager.close();
  event.preventDefault();
  shutdown();
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") {
    shutdown();
  }
});

app.on("activate", () => {
  if (app.isReady() && !windowManager.window) {
    windowManager.open();
  }
});

// Handle custom protocol on Linux when Upstream is already running
app.on("second-instance", (_event, argv, _workingDirectory) => {
  const parsedUrl = parseRadicleUrl(argv[1]);
  if (parsedUrl) {
    throttled(() => {
      windowManager.focus();
      windowManager.sendMessage({
        kind: MainMessageKind.CUSTOM_PROTOCOL_INVOCATION,
        data: { url: parsedUrl },
      });
    });
  }
});

process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});

main(app, config).catch(err => {
  console.error("Failed to start app");
  console.error(err);
  process.exit(2);
});

const windowManager = new WindowManager();
const proxyProcessManager = new ProxyProcessManager(
  proxyProcessOptions(config)
);

function setupWatcher() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const chokidar = require("chokidar");
  const watcher = chokidar.watch(path.join(__dirname, "../public/**"), {
    ignoreInitial: true,
  });

  watcher.on("change", () => {
    windowManager.reload();
  });
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  await proxyProcessManager.shutdown().catch(e => console.error(e));
  app.exit();
}

async function main(app: App, config: Config) {
  if (config.radHome) {
    const electronPath = path.resolve(config.radHome, "electron");
    fs.mkdirSync(electronPath, { recursive: true });
    app.setPath("userData", electronPath);
    app.setPath("appData", electronPath);
  }

  // The first instance will handle this via the `second-instance`
  // event.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  }

  if (config.environment === "production") {
    await installPrograms();
  }

  installMainProcessHandler(createMainProcessIpcHandlers());

  // Handle custom protocol on Linux when Upstream is not running
  const parsedUrl = parseRadicleUrl(process.argv[1]);
  if (parsedUrl) {
    throttled(() => {
      windowManager.sendMessage({
        kind: MainMessageKind.CUSTOM_PROTOCOL_INVOCATION,
        data: { url: parsedUrl },
      });
    });
  }

  await app.whenReady();

  proxyProcessManager.run().then(({ status, signal, output }) => {
    windowManager.sendMessage({
      kind: MainMessageKind.PROXY_ERROR,
      data: {
        status,
        signal,
        output,
      },
    });
  });

  if (config.environment === "development") {
    setupWatcher();
  }

  windowManager.open();
}

function proxyProcessOptions(config: Config): ProxyProcessOptions {
  let proxyPath;
  if (isWindows) {
    proxyPath = path.join(distBinPath, "radicle-proxy.exe");
  } else {
    proxyPath = path.join(distBinPath, "radicle-proxy");
  }

  let proxyArgs: string[];
  if (config.environment === "development") {
    proxyArgs = [
      "--unsafe-fast-keystore",
      "--dev-log",
      "--http-listen",
      config.httpAddr,
    ];
  } else {
    proxyArgs = [];
  }

  return {
    proxyPath,
    proxyArgs,
    lineLimit: 500,
    env: {
      RAD_HOME: config.radHome,
    },
  };
}

function installMainProcessHandler(handler: MainProcess) {
  mainProcessMethods.forEach(method => {
    ipcMain.handle(method, async (_event, arg) => handler[method](arg));
  });
}

function createMainProcessIpcHandlers(): MainProcess {
  return {
    async getProxyLogs(): Promise<string> {
      return proxyProcessManager.getOutputBuffer();
    },
    async clipboardWriteText(text: string): Promise<void> {
      clipboard.writeText(text);
    },
    async getVersion(): Promise<string> {
      if (config.environment === "development") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const version = require("../package.json")["version"];
        const { stdout, stderr } = await execa("git", ["rev-parse", "HEAD"]);

        if (!version || stderr) {
          return "0.0.0";
        } else {
          return `${version}-${stdout.trim()}`;
        }
      } else {
        return app.getVersion();
      }
    },
    async openPath(path: string): Promise<void> {
      shell.openPath(path);
    },
    async openUrl(url: string): Promise<void> {
      openExternalLink(url);
    },
    async getGitGlobalDefaultBranch(): Promise<string | undefined> {
      try {
        const { stdout, stderr } = await execa("git", [
          "config",
          "--global",
          "--get",
          "init.defaultBranch",
        ]);
        return stderr ? undefined : stdout.trim();
      } catch (error: unknown) {
        return undefined;
      }
    },
    async selectDirectory(): Promise<string> {
      const window = windowManager.window;
      if (window === null) {
        return "";
      }

      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "showHiddenFiles", "createDirectory"],
      });

      if (result.filePaths.length === 1) {
        return result.filePaths[0];
      } else {
        return "";
      }
    },
  };
}

async function installPrograms(): Promise<void> {
  const targetBinFolder = path.join(os.homedir(), ".radicle", "bin");
  await fs.promises.mkdir(targetBinFolder, { recursive: true });

  const programs = ["upstream", "git-remote-rad"];

  for (const program of programs) {
    await fs.promises.copyFile(
      path.join(distBinPath, program),
      path.join(targetBinFolder, program)
    );
  }
}
