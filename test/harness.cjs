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

/* A small moment stand-in (2026-09-07). Obsidian exports its bundled
 * moment; node has none, so the stub formats the tokens the display
 * formats are tested with, deterministically: YYYY YY MMMM MMM MM M DD D
 * Do dddd ddd HH H hh h mm m ss s A a, the locale shortcuts LT LTS L LL,
 * and [bracketed] literals. Input is a Date, or a YYYY-MM-DD string read
 * as a local day, or anything else Date can parse. Like moment, format
 * never throws, and an invalid date formats as "Invalid date".
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n) => String(n).padStart(2, '0');
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th')}`;
function momentStub(input, format) {
  let d;
  if (input instanceof Date) d = new Date(input.getTime());
  else if (typeof input === 'string' && format === 'YYYY-MM-DD' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, day] = input.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else if (input == null) d = new Date();
  else d = new Date(input);
  const valid = d instanceof Date && !Number.isNaN(d.getTime());
  const token = (t) => {
    const h = d.getHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    switch (t) {
      case 'YYYY': return String(d.getFullYear());
      case 'YY': return String(d.getFullYear()).slice(-2);
      case 'MMMM': return MONTHS[d.getMonth()];
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM': return p2(d.getMonth() + 1);
      case 'M': return String(d.getMonth() + 1);
      case 'DD': return p2(d.getDate());
      case 'Do': return ordinal(d.getDate());
      case 'D': return String(d.getDate());
      case 'dddd': return DAYS[d.getDay()];
      case 'ddd': return DAYS[d.getDay()].slice(0, 3);
      case 'HH': return p2(h);
      case 'H': return String(h);
      case 'hh': return p2(h12);
      case 'h': return String(h12);
      case 'mm': return p2(d.getMinutes());
      case 'm': return String(d.getMinutes());
      case 'ss': return p2(d.getSeconds());
      case 's': return String(d.getSeconds());
      case 'A': return h < 12 ? 'AM' : 'PM';
      case 'a': return h < 12 ? 'am' : 'pm';
      default: return t;
    }
  };
  const expand = (f) => f.replace(/LTS|LT|LL|L/g, (m) => ({ LTS: 'h:mm:ss A', LT: 'h:mm A', LL: 'MMMM D, YYYY', L: 'MM/DD/YYYY' })[m]);
  return {
    isValid: () => valid,
    format: (fmt) => {
      if (!valid) return 'Invalid date';
      const f = expand(fmt == null ? '' : String(fmt));
      return f.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g, (m, lit) => (lit != null ? lit : token(m)));
    },
    toDate: () => new Date(d.getTime()),
  };
}

const stub = {
  Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, TFolder, Menu, Modal,
  requestUrl: async () => ({ status: 200, text: '' }),
  setIcon: () => { },
  normalizePath: (p) => p,
  Platform: { isMobile: false, isDesktop: true, isDesktopApp: true, isMobileApp: false },
  moment: momentStub,
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
