// =============================================================
// SCHEDULE ROBOT
// Runs on GitHub (GitHub Actions) every night. Opens the public MKL and RKL
// schedule pages in a real (headless) browser, reads the games and saves them
// to data/schedules.json. The app then reads that file.
//
// It also saves small "debug" snapshots so the parser can be improved if a
// league changes its website.
// =============================================================
import { chromium } from "playwright";
import fs from "node:fs/promises";

const OUT = "data/schedules.json";
const DEBUG_DIR = "data/debug";
const UA = "AthletePlannerBot/0.1 (+https://github.com/kriksciunasa/athlete-planner)";

const MKL = {
  "U19 vaikinai": 3414, "U18 vaikinai": 603, "U17 vaikinai": 573, "U16 vaikinai": 613,
  "U15 vaikinai": 623, "U14 vaikinai": 633, "U13 vaikinai": 643, "U12 vaikinai": 683,
  "U18 merginos": 563, "U16 merginos": 593, "U14 merginos": 583, "U13 merginos": 8033, "U12 merginos": 653
};
const RKL_GROUPS = ["A divizionas", "B divizionas, A grupė", "B divizionas, B grupė", "B divizionas, C grupė", "B divizionas, D grupė"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").toLowerCase().replace(/[,.]/g, "").replace(/\s+/g, " ").trim();

// Runs inside the page: turns every table row into a list of cell texts + links.
function readRows() {
  return [...document.querySelectorAll("tr")].map(tr => ({
    cells: [...tr.querySelectorAll("td,th")].map(td => td.innerText.replace(/\s+/g, " ").trim()),
    links: [...tr.querySelectorAll("a[href]")].map(a => a.href)
  })).filter(r => r.cells.length >= 3);
}

const DATE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const DATE_DOT = /\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?\b/;
const TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const NOISE = /^(youtube|apžvalga|tiesiogiai|live|bilietai|statistika|-|—|vs|:)$/i;

function guessYear(month) { const now = new Date(); const m = now.getMonth() + 1; return month >= 8 ? (m >= 8 ? now.getFullYear() : now.getFullYear() - 1) : (m >= 8 ? now.getFullYear() + 1 : now.getFullYear()); }
function toIso(text) {
  let m = text.match(DATE_ISO); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(DATE_DOT); if (m) { const d = +m[1], mo = +m[2], y = m[3] ? +m[3] : guessYear(mo); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  return null;
}

// Generic row parser: a game row has a date (in the row or in the heading row above),
// a start time, and two team names. Venue = the longest remaining text with a comma.
function parseRows(rows) {
  const games = []; let currentDate = null;
  for (const r of rows) {
    const joined = r.cells.join(" | ");
    const dateCell = r.cells.find(c => DATE_ISO.test(c)) || r.cells.find(c => toIso(c) && !TIME.test(c));
    const time = (r.cells.find(c => TIME.test(c)) || "").match(TIME);
    if (!time) { const d = toIso(joined); if (d) currentDate = d; continue; } // heading row with only a date
    const date = (dateCell && toIso(dateCell)) || toIso(joined) || currentDate;
    if (!date) continue;
    const teams = r.cells.filter(c => c && !TIME.test(c) && !toIso(c) && !NOISE.test(c) && !/\d+\s*[:–-]\s*\d+/.test(c) && c.length > 1 && c.length < 60 && !/,/.test(c));
    if (teams.length < 2) continue;
    const venue = r.cells.filter(c => /,/.test(c)).sort((a, b) => b.length - a.length)[0] || "";
    const link = r.links.find(l => /rungtynes\/\d+|match|game|rungtyn/i.test(l)) || "";
    games.push({ date, time: `${time[1].padStart(2, "0")}:${time[2]}`, home: teams[0], away: teams[1], venue, url: link });
  }
  // remove duplicates
  const seen = new Set();
  return games.filter(g => { const k = `${g.date}|${g.time}|${g.home}|${g.away}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function saveDebug(name, page, extra) {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const html = await page.content();
  await fs.writeFile(`${DEBUG_DIR}/${name}.html`, html.slice(0, 400000));
  if (extra) await fs.writeFile(`${DEBUG_DIR}/${name}.json`, JSON.stringify(extra, null, 1).slice(0, 400000));
}

async function scrapeRKL(browser, report) {
  const page = await browser.newPage({ userAgent: UA });
  const out = {};
  await page.goto("https://www.rkl.lt/rungtynes/#tvarkarastis", { waitUntil: "networkidle", timeout: 60000 });
  await saveDebug("rkl-initial", page, await page.evaluate(readRows));
  // find the division <select>
  const selectInfo = await page.evaluate(() => {
    const s = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => /divizion/i.test(o.text)));
    if (!s) return null;
    s.setAttribute("data-ap", "division");
    return [...s.options].map(o => ({ value: o.value, text: o.text.trim() }));
  });
  report.rklSelect = selectInfo;
  for (const group of RKL_GROUPS) {
    try {
      if (selectInfo) {
        const opt = selectInfo.find(o => norm(o.text) === norm(group));
        if (!opt) { report.errors.push(`RKL: option not found: ${group}`); continue; }
        await page.selectOption('select[data-ap="division"]', opt.value);
        // submit the filter form if there is one
        await page.evaluate(() => {
          const s = document.querySelector('select[data-ap="division"]'), f = s.closest("form");
          if (f) { const b = f.querySelector('button, input[type="submit"]'); b ? b.click() : f.submit(); }
        });
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await sleep(1500);
        await page.evaluate(() => { const s = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => /divizion/i.test(o.text))); if (s) s.setAttribute("data-ap", "division"); });
      }
      const rows = await page.evaluate(readRows);
      out[group] = parseRows(rows);
      report.counts[`RKL ${group}`] = out[group].length;
      if (group === RKL_GROUPS[0]) await saveDebug("rkl-a", page, rows);
    } catch (e) { report.errors.push(`RKL ${group}: ${e.message}`); }
  }
  await page.close();
  return out;
}

async function scrapeMKL(browser, report) {
  const out = {};
  for (const [group, id] of Object.entries(MKL)) {
    const page = await browser.newPage({ userAgent: UA });
    const jsonHits = [];
    page.on("response", async res => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json") && jsonHits.length < 15) { const body = await res.text(); jsonHits.push({ url: res.url(), body: body.slice(0, 20000) }); }
      } catch (e) { /* ignore */ }
    });
    try {
      await page.goto(`https://mkl.lt/league/${id}/schedule`, { waitUntil: "networkidle", timeout: 60000 });
      await sleep(3000);
      const rows = await page.evaluate(readRows);
      out[group] = parseRows(rows);
      report.counts[`MKL ${group}`] = out[group].length;
      if (group === "U16 vaikinai") await saveDebug("mkl-u16", page, { rows: rows.slice(0, 80), json: jsonHits });
    } catch (e) { report.errors.push(`MKL ${group}: ${e.message}`); }
    await page.close();
    await sleep(1000); // be polite to the league's server
  }
  return out;
}

const report = { counts: {}, errors: [] };
const browser = await chromium.launch();
let previous = {};
try { previous = JSON.parse(await fs.readFile(OUT, "utf8")); } catch (e) { /* first run */ }
const leagues = { RKL: await scrapeRKL(browser, report), MKL: await scrapeMKL(browser, report) };
await browser.close();

// Keep the previous data for a group if this run found nothing (site down, etc.)
for (const L of ["RKL", "MKL"]) for (const g of Object.keys(previous.leagues?.[L] || {}))
  if (!leagues[L][g]?.length && previous.leagues[L][g]?.length) { leagues[L][g] = previous.leagues[L][g]; report.errors.push(`${L} ${g}: kept previous data`); }

await fs.mkdir("data", { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), leagues }, null, 1));
await fs.writeFile(`${DEBUG_DIR}/report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
