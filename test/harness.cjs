/* Headless access to main.js.
 *
 * main.js is hand-written CommonJS with no build step, so the only thing
 * between it and node is `require('obsidian')`. That is stubbed here with real
 * classes, because the module body evaluates `class X extends Plugin` at load
 * time. Nothing in main.js touches `document` or `window` at load.
 *
 * PLANNER_MAIN lets the suite be pointed at a DIFFERENT main.js. Two uses:
 * running a gate against the bytes a particular vault actually loads, and
 * proving a test goes red by pointing it at a deliberately regressed copy.
 * A gate that has only ever been seen green is not evidence.
 */
'use strict';
const path = require('node:path');
const Module = require('node:module');

class Plugin { }
class ItemView { }
class PluginSettingTab { }
class Setting { }
class Notice { }
class TFile { }
class TFolder { }
class Menu { }
class Modal { }

const stub = {
  Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, TFolder, Menu, Modal,
  requestUrl: async () => ({ status: 200, text: '' }),
  setIcon: () => { },
  normalizePath: (p) => p,
  Platform: { isMobile: false, isDesktop: true, isDesktopApp: true, isMobileApp: false },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return originalLoad.apply(this, arguments);
};

const target = process.env.PLANNER_MAIN
  ? path.resolve(process.env.PLANNER_MAIN)
  : path.join(__dirname, '..', 'main.js');

module.exports = require(target).__test;
module.exports.__mainPath = target;
// The stub itself, so a test can flip what main.js sees (Platform.isDesktop
// is the one a test needs today). Restore what you change.
module.exports.__obsidian = stub;
