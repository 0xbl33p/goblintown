import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, session, shell, systemPreferences, type MediaAccessPermissionRequest } from "electron";
import { serve, type ServeHandle } from "./server.js";
import { initWarren, loadWarren } from "./warren.js";

let mainWindow: BrowserWindow | null = null;
let serverHandle: ServeHandle | null = null;

async function ensureDesktopWarren(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  try {
    await loadWarren(root);
  } catch {
    await initWarren(root);
  }
}

function sameOrigin(value: string | undefined, origin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === origin;
  } catch {
    return value === origin;
  }
}

function isAppOrigin(origin: string, requestingOrigin: string, requestingUrl?: string): boolean {
  return sameOrigin(requestingOrigin, origin) || sameOrigin(requestingUrl, origin);
}

function configureMediaPermissions(origin: string): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    if (details.mediaType !== "audio") return false;
    return isAppOrigin(origin, requestingOrigin, details.requestingUrl);
  });
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }
    const mediaDetails = details as MediaAccessPermissionRequest;
    const wantsAudio = Array.isArray(mediaDetails.mediaTypes) && mediaDetails.mediaTypes.includes("audio");
    const wantsVideo = Array.isArray(mediaDetails.mediaTypes) && mediaDetails.mediaTypes.includes("video");
    const trustedOrigin = isAppOrigin(origin, mediaDetails.securityOrigin || "", mediaDetails.requestingUrl);
    if (!wantsAudio || wantsVideo || !trustedOrigin) {
      callback(false);
      return;
    }
    if (process.platform !== "darwin") {
      callback(true);
      return;
    }
    systemPreferences.askForMediaAccess("microphone")
      .then((granted) => callback(granted))
      .catch(() => callback(false));
  });
}

async function createWindow(): Promise<void> {
  const root = process.env.GOBLINTOWN_DESKTOP_ROOT ?? join(app.getPath("userData"), "warren");
  await ensureDesktopWarren(root);
  serverHandle = await serve({ cwd: root, port: 0 });
  configureMediaPermissions(new URL(serverHandle.url).origin);

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: "Goblintown",
    backgroundColor: "#120f08",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(serverHandle?.url ?? "")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(serverHandle.url);
}

app.whenReady().then(() => {
  void createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (!serverHandle) return;
  event.preventDefault();
  const handle = serverHandle;
  serverHandle = null;
  await handle.close().catch(() => {});
  app.exit(0);
});
