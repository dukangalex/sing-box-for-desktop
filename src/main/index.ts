import { app, BrowserWindow, crashReporter, dialog, ipcMain, screen, session, shell } from "electron";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  APP_NAVIGATE,
  APP_TITLE_BAR_OVERLAY,
  DEEP_LINK_IMPORT,
  PROFILE_FILE_IMPORT,
  TAILDROP_SEND_REQUEST,
  UPDATES_PRESENT,
} from "../shared/ipc";
import type {
  DeepLinkImport,
  ProfileFileImport,
  TaildropSendFile,
  TitleBarOverlayColors,
} from "../shared/ipc";
import { configureApplicationPaths } from "./applicationPaths";
import {
  archiveNativeCrashDumps,
  captureRuntimeCrash,
} from "./appReports";
import type { RuntimeCrashCaptureResult } from "./appReports";
import { registerApplication } from "./application";
import { registerDaemonBridge } from "./bridge";
import { registerCloudBackup } from "./cloudBackup";
import { registerCore } from "./core";
import { settingsDatabase } from "./database";
import { developmentRendererURL, developmentSwitchValue } from "./development";
import { applyDisplayScaleFactor } from "./displayScale";
import { hasLoginItemArgument, migrateLoginItem, wasOpenedAtLogin } from "./loginItem";
import { registerNotifications } from "./notifications";
import { registerPreferences } from "./preferences";
import { registerOpenConnectBrowser } from "./openConnectBrowser";
import { registerProfileEditorWindows } from "./profileEditorWindows";
import { registerProfileChains } from "./profileChains";
import { registerProfiles } from "./profiles";
import { registerSetup } from "./repair";
import { registerReports } from "./reports";
import { resourcePath } from "./resources";
import { registerServers } from "./servers";
import {
  registerSettings,
  saveMainWindowState,
  storedMainWindowState,
  trayEnabled,
  trayInBackground,
} from "./settings";
import { daemonState } from "./state";
import { createTaildropSendBatcher, registerTaildrop, taildropSendPaths } from "./taildrop";
import { initializeTray, updateTrayVisibility } from "./tray";
import { registerUpdates, runStartupUpdateCheck } from "./updates";
import { prepareTrayMenuWindow, showTrayMenu } from "./trayMenu";
import { registerTerminalWindows } from "./terminalWindows";
import { applyTitleBarOverlayColors, titleBarOverlay } from "./titleBarOverlay";
import {
  MAIN_WINDOW_MINIMUM_HEIGHT,
  MAIN_WINDOW_MINIMUM_WIDTH,
  restoredMainWindowBounds,
} from "./windowState";
