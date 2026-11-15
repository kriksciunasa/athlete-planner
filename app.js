// =============================================================
// ATHLETE PLANNER — app logic
//
// The idea: DATA → DRAW → CLICK → CHANGE DATA → DRAW AGAIN.
//   1. `state` holds everything the user entered (saved on the phone).
//   2. `render()` draws the current screen from `state`.
//   3. Clicks call an "action" that changes `state`, saves it, and draws again.
//
// The calendar is not stored day by day. It is CALCULATED from the user's
// rules (practice days, rest days, S&C days...) plus their games. That's why
// moving a game automatically moves the rest/light days around it.
// =============================================================

const VERSION = "0.2.1";
// Demo mode: open the app with ?demo to see a sample season (stored separately from real data)
const DEMO = new URLSearchParams(location.search).has("demo") || location.hash === "#demo";
const STORAGE_KEY = DEMO ? "athlete-planner.demo" : "athlete-planner.v1";
const FEEDBACK_URL = ""; // TODO: paste the Google Form link here

// ---------- 1. DATE HELPERS ----------
const pad = n => String(n).padStart(2, "0");
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
const mondayOf = k => { const d = parse(k); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const toMin = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ageOn(dob, k = todayKey()) {
  if (!dob) return null;
  const b = parse(dob), d = parse(k);
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}
function seasonEnd(k) { const d = parse(k); const y = d.getMonth() >= 5 ? d.getFullYear() + 1 : d.getFullYear(); return `${y}-05-31`; }
function seasonYearEnd(k) { const d = parse(k); const y = d.getMonth() >= 8 ? d.getFullYear() + 1 : d.getFullYear(); return `${y}-08-31`; }
function isoWeek(k) {
  const d = parse(k); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
function hm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return state.lang === "lt" ? `${h} val.${m ? " " + m + " min." : ""}` : `${h} h${m ? " " + m + " min" : ""}`;
}

// ---------- 2. TRANSLATION HELPER ----------
function t(k, vars) {
  let s = (T[state.lang] && T[state.lang][k]) ?? T.lt[k] ?? k;
  if (vars && typeof s === "string") for (const v in vars) s = s.replaceAll(`{${v}}`, vars[v]);
  return s;
}
const fmtShort = k => { const d = parse(k); return state.lang === "lt" ? `${d.getDate()} ${t("monthsShort")[d.getMonth()]}` : `${d.getDate()} ${t("monthsShort")[d.getMonth()]}`; };
const fmtDay = k => `${t("weekdays")[parse(k).getDay()]} · ${fmtShort(k)}`;

// ---------- 3. DATA (saved on the phone) ----------
function defaultState() {
  return {
    v: 1, lang: "lt", onboarded: false,
    setup: {
      profile: { sport: "basketball", dob: "", gender: "", years: "", height: "", fitness: 3, parentOk: false },
      leagues: [{ source: "MKL", group: "", team: "", name: "", url: "" }],
      practice: { days: [1, 2, 3, 4, 5], start: "16:15", dur: 105 },
      rest: { days: [0], afterGame: true, beforeGame: false, seasonEnd: "" },
      skills: { enabled: true, days: [6], start: "10:00", dur: 60, focus: "" },
      sc: { enabled: true, days: [1, 3, 5], when: "after", start: "18:30", dur: 45, fileName: "", wantRecs: false }
    },
    startDate: "", endDate: "",
    games: [],   // { id, date, start, dur, opponent, home, venue, league, status, origDate }
    custom: [],  // { id, date, start, dur, type, title }
    over: {},    // changes to generated sessions: { [id]: { cancelled, start, dur } }
    log: {},     // check-ins: { [id]: { rpe, minutes, pain, area, dur, type, date } }
    tests: { jumps: [], heights: [] },
    reminders: defaultReminders()
  };
}
// Recommended reminder rules. "before" = minutes before start (0 = none), "eve" = the evening before.
function defaultReminders() {
  return {
    eveTime: "20:00", quiet: true,
    game: { eve: true, before: 180 },
    team: { eve: false, before: 30 },
    sc: { eve: false, before: 30 },
    skills: { eve: false, before: 60 },
    recovery: { eve: false, before: 0 },
    other: { eve: false, before: 30 }
  };
}
let state;
try { state = Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {}); }
catch (e) { state = defaultState(); }
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked: app still works this session */ } }

// What's on screen right now (not saved)
const ui = {
  screen: state.onboarded ? "main" : "welcome",
  step: 1, editing: false, error: "",
  tab: "cal", view: "day", cursor: todayKey(), loadWeek: mondayOf(todayKey()),
  sheet: null, form: {}, newGame: { date: "", start: "18:00", opponent: "", home: true, venue: "", league: "" },
  jump: ["", "", ""], heightIn: "", installEvt: null
};

// ---------- 4. THE PLAN ENGINE ----------
// Returns everything on a given day, calculated from the rules.
const activeGames = () => state.games.filter(g => g.status !== "cancelled");
const hasGame = k => activeGames().some(g => g.date === k);

function dayPlan(k) {
  const s = state.setup, wd = parse(k).getDay();
  const inSeason = state.startDate && k >= state.startDate && k <= state.endDate;
  const games = state.games.filter(g => g.date === k);
  const isGame = games.some(g => g.status !== "cancelled");
  const afterGame = s.rest.afterGame && hasGame(addDays(k, -1));
  const fixedRest = s.rest.days.includes(wd);
  const rest = !isGame && (fixedRest || afterGame);
  const items = [];

  if (inSeason && !isGame && !rest) {
    if (s.rest.beforeGame && hasGame(addDays(k, 1))) {
      items.push(gen(k, "recovery", s.practice.start, 30));
    } else {
      let teamEnd = null;
      if (s.practice.days.includes(wd)) { items.push(gen(k, "team", s.practice.start, s.practice.dur)); teamEnd = toMin(s.practice.start) + Number(s.practice.dur); }
      if (s.skills.enabled && s.skills.days.includes(wd)) items.push(gen(k, "skills", s.skills.start, s.skills.dur));
      if (s.sc.enabled && s.sc.days.includes(wd)) {
        const st = s.sc.when === "after" && teamEnd !== null ? fromMin(teamEnd + 15) : s.sc.start;
        items.push(gen(k, "sc", st, s.sc.dur));
      }
    }
  }
  for (const g of games) items.push({ id: g.id, kind: "game", type: "game", date: k, start: g.start, dur: Number(g.dur) || 90, cancelled: g.status === "cancelled", game: g });
  for (const c of state.custom.filter(c => c.date === k)) items.push({ id: c.id, kind: "custom", type: c.type, date: k, start: c.start, dur: Number(c.dur) || 60, title: c.title, custom: c });

  items.sort((a, b) => toMin(a.start) - toMin(b.start));
  const active = items.filter(i => !i.cancelled);
  return { k, items, active, rest: rest && active.length === 0, restReason: afterGame && !fixedRest ? "after" : "fixed" };
}
function gen(k, type, start, dur) {
  const id = `${k}|${type}`, o = state.over[id] || {};
  return { id, kind: "gen", type, date: k, start: o.start || start, dur: Number(o.dur || dur), cancelled: !!o.cancelled };
}
function findItem(id, k) { return dayPlan(k).items.find(i => i.id === id); }
function itemTitle(i) {
  if (i.type === "game") { const g = i.game; return `${g.home ? t("vs") : "@"} ${g.opponent || "—"}`; }
  return i.title || t("types")[i.type] || i.type;
}

// Week statistics for the Load screen
function weekStats(mon) {
  let planned = 0, load = 0, logged = 0, daysOff = 0, pains = [], games = 0;
  for (let n = 0; n < 7; n++) {
    const p = dayPlan(addDays(mon, n));
    if (p.active.length === 0) daysOff++;
    for (const i of p.active) {
      planned += i.dur;
      if (i.type === "game") games++;
      const l = state.log[i.id];
      if (l) { load += l.rpe * (l.dur || i.dur); logged++; if (l.pain) pains.push(l.area); }
    }
  }
  return { planned, load, logged, daysOff, pains, games };
}
function acwr(mon) {
  const cur = weekStats(mon).load;
  const prev = [1, 2, 3, 4].map(n => weekStats(addDays(mon, -7 * n)).load);
  if (prev.filter(v => v > 0).length < 3 || cur === 0) return null;
  const avg = prev.reduce((a, b) => a + b, 0) / 4;
  return avg > 0 ? cur / avg : null;
}
function hourLimit() {
  const a = ageOn(state.setup.profile.dob);
  return a !== null && a < 19 ? Math.min(a, 16) : null;
}

// ---------- 5. ICONS ----------
const ICON = {
  back: '<path d="m15 18-6-6 6-6"/>', fwd: '<path d="m9 18 6-6-6-6"/>', plus: '<path d="M5 12h14M12 5v14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', check: '<path d="M20 6 9 17l-5-5"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  load: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', tests: '<path d="M3 21h18M6 21V10M12 21V4M18 21v-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11"/>', users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15l3-3 3 3"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v7M9 11l3 3 3-3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'
};
const ic = (n, style = "") => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" ${style ? `style="${style}"` : ""}>${ICON[n]}</svg>`;
const typeIcon = { game: "trophy", team: "users", skills: "target", sc: "dumbbell", recovery: "moon", other: "cal" };

// ---------- 6. SMALL UI PIECES ----------
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
function dayChips(path, selected, color = "") {
  return `<div class="days" role="group">${WEEK_ORDER.map(d => {
    const on = selected.includes(d);
    return `<button class="chip ${on ? "on " + color : ""}" aria-pressed="${on}" data-a="toggleDay" data-p="${path}" data-d="${d}">${t("wdShort")[d]}</button>`;
  }).join("")}</div>`;
}
function seg(path, options, value, cls = "") {
  return `<div class="seg ${cls}" role="radiogroup">${options.map(([v, label]) =>
    `<button role="radio" aria-checked="${String(v) === String(value)}" class="${String(v) === String(value) ? "on" : ""}" data-a="set" data-p="${path}" data-v="${esc(v)}">${esc(label)}</button>`).join("")}</div>`;
}
const field = (label, input) => `<label class="field">${esc(label)}${input}</label>`;
const input = (path, value, type = "text", extra = "") => `<input class="inp" type="${type}" data-f="${path}" value="${esc(value)}" ${extra}>`;
const durSelect = (path, value, opts = [30, 45, 60, 75, 90, 105, 120, 150]) =>
  `<select class="inp" data-f="${path}" data-t="num">${opts.map(o => `<option value="${o}" ${Number(value) === o ? "selected" : ""}>${o} ${t("min")}</option>`).join("")}</select>`;
const timeInput = (path, value) => input(path, value, "time");

function header(step, total) {
  return `<div class="row between">
    <button class="icon-btn plain" aria-label="${t("back")}" data-a="back" style="margin-left:-10px">${ic("back")}</button>
    <span class="label">${t("stepOf", { a: step, b: total })}</span></div>
    <div class="progress" style="grid-template-columns:repeat(${total},1fr)">${Array.from({ length: total }, (_, i) => `<span class="${i < step ? "on" : ""}"></span>`).join("")}</div>`;
}
function tabbar() {
  const tabs = [["cal", "cal", t("tabCal")], ["load", "load", t("tabLoad")], ["tests", "tests", t("tabTests")], ["profile", "user", t("tabProfile")]];
  return `<div class="tabbar"><nav aria-label="Main">${tabs.map(([id, icon, label]) =>
    `<button class="${ui.tab === id ? "on" : ""}" data-a="tab" data-v="${id}" aria-current="${ui.tab === id}">${ic(icon)}${label}</button>`).join("")}</nav></div>`;
}

// ---------- 7. SCREENS ----------
const STEPS = ["about", "games", "practice", "rest", "skills", "sc", "review"];

function screenWelcome() {
  const ex = [["", 0], ["g", 1], ["g", 2], ["g", 3], ["v", 4], ["g", 5], ["", 6]];
  return `<div class="scr" style="position:relative;overflow:hidden">
    <svg class="deco" width="220" height="220" viewBox="0 0 220 220" aria-hidden="true"><rect width="220" height="220" fill="#D7FF3C"/>
      <polyline points="46,70 82,110 46,150" fill="none" stroke="#0A0B0A" stroke-width="14"/><polyline points="92,70 128,110 92,150" fill="none" stroke="#0A0B0A" stroke-width="14"/></svg>
    <div class="wordmark"><i></i><span>${t("appName")}</span></div>
    <div style="margin-top:72px" class="col">
      <h1 class="h1 xl">${esc(t("welcomeTitle"))}</h1>
      <p class="p" style="max-width:320px">${esc(t("welcomeText"))}</p>
    </div>
    <div class="card">
      <span class="label">${t("exampleWeek")}</span>
      <div class="days">${ex.map(([c, i]) => `<div class="col center" style="gap:6px;align-items:center"><span class="xs muted">${t("wdLetter")[WEEK_ORDER[i]]}</span><span style="width:100%;height:28px;border-radius:6px;background:${c === "v" ? "var(--volt)" : c === "g" ? "var(--green)" : "var(--black-700)"}"></span></div>`).join("")}</div>
      <div class="row xs muted" style="gap:16px"><span class="row" style="gap:6px"><span class="dot game"></span>${t("legendGame")}</span><span class="row" style="gap:6px"><span class="dot"></span>${t("legendTraining")}</span><span class="row" style="gap:6px"><span class="dot" style="background:var(--black-700);border:1px solid var(--ink-muted)"></span>${t("restDay")}</span></div>
    </div>
    <div class="grow"></div>
    <div class="col" style="gap:12px">
      <button class="btn" data-a="start">${t("createPlan")} ${ic("arrow")}</button>
      ${seg("lang", [["lt", "Lietuvių"], ["en", "English"]], state.lang)}
      <p class="small muted center" style="margin:0">${t("stepsNote", { n: STEPS.length })}</p>
    </div></div>`;
}

function screenOnboarding() {
  const s = state.setup, name = STEPS[ui.step - 1];
  let body = "";
  if (name === "about") {
    const age = ageOn(s.profile.dob);
    body = `<h1 class="h1">${t("aboutTitle")}</h1><p class="p">${t("aboutText")}</p>
      <div class="grid2">
        ${field(t("sport"), `<select class="inp" data-f="setup.profile.sport">${Object.entries(t("sports")).map(([k, v]) => `<option value="${k}" ${s.profile.sport === k ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
        ${field(t("dob"), input("setup.profile.dob", s.profile.dob, "date", `max="${todayKey()}"`))}
      </div>
      <div class="field">${t("gender")}${seg("setup.profile.gender", [["m", t("genders").m], ["f", t("genders").f], ["x", t("genders").x]], s.profile.gender)}</div>
      <div class="grid2">
        ${field(t("years"), input("setup.profile.years", s.profile.years, "number", 'min="0" max="40" inputmode="numeric" data-t="num"'))}
        ${field(t("height"), input("setup.profile.height", s.profile.height, "number", 'min="0" max="250" inputmode="numeric" placeholder="172" data-t="num"'))}
      </div>
      <div class="field">${t("fitness")}${seg("setup.profile.fitness", [1, 2, 3, 4, 5].map(n => [n, n]), s.profile.fitness)}
        <span class="small" style="color:var(--ink)">${esc(t("fitnessLevels")[s.profile.fitness] || "")}</span></div>
      ${age !== null && age < 18 ? `<div class="card tight row" style="flex-direction:row">${ic("users", "color:var(--volt);width:18px;height:18px")}<span class="small muted">${t("under18Note")}</span></div>` : ""}`;
  }
  if (name === "games") {
    body = `<h1 class="h1">${t("gamesTitle")}</h1><p class="p">${t("gamesText")}</p>
      ${s.leagues.map((l, i) => `<div class="card">
        <div class="row between"><span class="row bold" style="gap:8px">${ic("trophy", "color:var(--volt);width:20px;height:20px")}${t("league")} ${i + 1}</span>
          ${s.leagues.length > 1 ? `<button class="btn3 volt" data-a="removeLeague" data-i="${i}">${t("removeLeague")}</button>` : ""}</div>
        ${seg(`setup.leagues.${i}.source`, [["MKL", "MKL"], ["RKL", "RKL"], ["other", t("other")]], l.source)}
        ${l.source !== "other" ? `
          ${field(t("group"), `<select class="inp" data-f="setup.leagues.${i}.group"><option value="">—</option>${LEAGUES[l.source].groups.map(g => `<option ${l.group === g ? "selected" : ""}>${g}</option>`).join("")}</select>`)}
          ${teamField(l, i)}` : `
          ${field(t("leagueName"), input(`setup.leagues.${i}.name`, l.name, "text"))}
          ${field(t("leagueUrl"), input(`setup.leagues.${i}.url`, l.url, "url", 'placeholder="https://"'))}
          <p class="small muted" style="margin:0">${t("otherHelp")}</p>`}
      </div>`).join("")}
      ${s.leagues.length < 3 ? `<button class="btn2 dashed" data-a="addLeague">${ic("plus")} ${t("addLeague")}</button>` : ""}
      ${ui.schedules ? `<p class="small muted" style="margin:0">${t("autoInfo")}</p>` : ""}
      ${!ui.schedules || ui.showManual || s.leagues.some(l => l.source === "other") ? gameForm() : `<button class="btn3 volt" style="width:100%" data-a="showManual">${ic("plus", "width:18px;height:18px")} ${t("addManual")}</button>`}`;
  }
  if (name === "practice") {
    body = `<h1 class="h1">${t("practiceTitle")}</h1><p class="p">${t("practiceText")}</p>
      <div class="card"><span class="row bold" style="gap:8px">${ic("users", "color:var(--green);width:20px;height:20px")}${t("days")}</span>
        ${dayChips("setup.practice.days", s.practice.days)}
        <div class="grid2">${field(t("start"), timeInput("setup.practice.start", s.practice.start))}${field(t("duration"), durSelect("setup.practice.dur", s.practice.dur))}</div></div>`;
  }
  if (name === "rest") {
    body = `<h1 class="h1">${t("restTitle")}</h1><p class="p">${t("restText")}</p>
      <div class="card"><span class="row bold" style="gap:8px">${ic("cal", "color:var(--volt);width:20px;height:20px")}${t("everyWeek")}</span>
        ${dayChips("setup.rest.days", s.rest.days, "volt")}</div>
      <div class="list">
        <div class="li" style="font-weight:600;gap:8px">${ic("moon", "color:var(--volt);width:20px;height:20px")}${t("aroundGames")}</div>
        <label class="check li"><input type="checkbox" data-f="setup.rest.beforeGame" ${s.rest.beforeGame ? "checked" : ""}><span>${t("dayBefore")}<span class="sub">${t("dayBeforeSub")}</span></span></label>
        <label class="check li"><input type="checkbox" data-f="setup.rest.afterGame" ${s.rest.afterGame ? "checked" : ""}><span>${t("dayAfter")}<span class="sub">${t("dayAfterSub")}</span></span></label>
      </div>
      <div class="card"><span class="row bold" style="gap:8px">${ic("cal", "color:var(--green);width:20px;height:20px")}${t("seasonEndTitle")}</span>
        ${field(t("seasonEnd"), input("setup.rest.seasonEnd", s.rest.seasonEnd || seasonEnd(todayKey()), "date"))}
        <span class="small muted">${t("seasonEndSub")}</span></div>`;
  }
  if (name === "skills") {
    body = `<h1 class="h1">${t("skillsTitle")}</h1><p class="p">${t("skillsText")}</p>
      ${s.skills.enabled ? `<div class="card"><span class="row bold" style="gap:8px">${ic("target", "color:var(--green);width:20px;height:20px")}${t("days")}</span>
        ${dayChips("setup.skills.days", s.skills.days)}
        <div class="grid2">${field(t("start"), timeInput("setup.skills.start", s.skills.start))}${field(t("duration"), durSelect("setup.skills.dur", s.skills.dur))}</div>
        ${field(t("focus"), input("setup.skills.focus", s.skills.focus, "text", `placeholder="${t("focusPh")}"`))}</div>` : ""}
      <label class="check card tight" style="flex-direction:row"><input type="checkbox" data-f="setup.skills.enabled" data-t="invert" ${!s.skills.enabled ? "checked" : ""}><span>${t("noSkills")}</span></label>`;
  }
  if (name === "sc") {
    body = `<h1 class="h1">${t("scTitle")}</h1><p class="p">${t("scText")}</p>
      ${s.sc.enabled ? `
      <label class="upload">${ic("file", "color:var(--volt);width:32px;height:32px")}<span class="bold">${s.sc.fileName ? esc(s.sc.fileName) : t("upload")}</span>
        <span class="small muted">${t("uploadSub")}</span><span class="btn2" style="width:auto;padding:0 20px;height:44px">${t("chooseFile")}</span>
        <input type="file" accept=".xlsx,.xls,.docx,.doc,.pdf" data-a="file"></label>
      <label class="check card tight" style="flex-direction:row"><input type="checkbox" data-f="setup.sc.wantRecs" ${s.sc.wantRecs ? "checked" : ""} style="accent-color:var(--volt)"><span>${t("wantRecs")}<span class="sub">${t("optional")}</span></span></label>
      <div class="card"><span class="row bold" style="gap:8px">${ic("dumbbell", "color:var(--green);width:20px;height:20px")}${t("scDays")}</span>
        ${dayChips("setup.sc.days", s.sc.days)}
        ${seg("setup.sc.when", [["after", t("afterPractice")], ["separate", t("separate")]], s.sc.when)}
        <div class="grid2">${s.sc.when === "separate" ? field(t("start"), timeInput("setup.sc.start", s.sc.start)) : "<span></span>"}${field(t("duration"), durSelect("setup.sc.dur", s.sc.dur))}</div></div>` : ""}
      <label class="check card tight" style="flex-direction:row"><input type="checkbox" data-f="setup.sc.enabled" data-t="invert" ${!s.sc.enabled ? "checked" : ""}><span>${t("noSc")}</span></label>`;
  }
  if (name === "review") {
    const p = s.profile, age = ageOn(p.dob), wd = d => d.map(x => t("wdShort")[x]).join(", ") || t("none");
    const row = (icon, color, label, value, step) => `<div class="li">${ic(icon, `color:${color};width:20px;height:20px`)}
      <span class="grow col" style="gap:2px"><span class="small muted">${label}</span><span class="bold" style="font-size:15px">${esc(value)}</span></span>
      <button class="btn3 volt" data-a="goStep" data-v="${step}">${t("edit")}</button></div>`;
    const leagues = s.leagues.filter(l => l.source === "other" ? l.name : l.group).map(l => l.source === "other" ? l.name : `${l.source} ${l.group}`);
    body = `<h1 class="h1">${t("reviewTitle")}</h1><p class="p">${t("reviewText")}</p>
      <div class="list">
        ${row("user", "var(--ink)", t("aboutTitle"), `${t("sports")[p.sport]} · ${age !== null ? t("ageN", { n: age }) : "—"} · ${t("fitness")}: ${p.fitness}/5`, 1)}
        ${row("trophy", "var(--volt)", t("gamesTitle"), (leagues.join(" · ") || t("none")) + ` · ${state.games.length}`, 2)}
        ${row("users", "var(--green)", t("practiceTitle"), `${wd(s.practice.days)} · ${s.practice.start}`, 3)}
        ${row("moon", "var(--ink-muted)", t("restTitle"), [wd(s.rest.days), s.rest.beforeGame ? t("dayBefore") : "", s.rest.afterGame ? t("dayAfter") : ""].filter(Boolean).join(" · "), 4)}
        ${row("target", "var(--green)", t("skillsTitle"), s.skills.enabled ? `${wd(s.skills.days)} · ${s.skills.start}` : t("none"), 5)}
        ${row("dumbbell", "var(--green)", t("scTitle"), s.sc.enabled ? `${wd(s.sc.days)} · ${s.sc.when === "after" ? t("afterPractice") : s.sc.start}` : t("none"), 6)}
      </div>
      ${age !== null && age < 18 ? `<label class="check card tight" style="flex-direction:row"><input type="checkbox" data-f="setup.profile.parentOk" ${p.parentOk ? "checked" : ""} style="accent-color:var(--volt)"><span class="small">${t("parentOk")}</span></label>` : ""}
      <div class="card tight row" style="flex-direction:row">${ic("lock", "color:var(--ink-muted);width:18px;height:18px")}<span class="small muted">${t("privacyShort")}</span></div>`;
  }
  const last = ui.step === STEPS.length;
  return `<div class="scr">${header(ui.step, STEPS.length)}${body}
    ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ""}
    <div class="grow"></div>
    <button class="btn" data-a="${last ? "finish" : "next"}">${last ? (ui.editing ? t("saveChanges") : t("buildSeason")) + " " + ic("arrow") : t("next")}</button></div>`;
}

// ---------- SCHEDULES FROM THE ROBOT ----------
// data/schedules.json is written every night by the GitHub robot (scripts/fetch-schedules.mjs).
function scheduleFor(l) { return ui.schedules?.leagues?.[l.source]?.[l.group] || null; }
function teamsFor(l) {
  const games = scheduleFor(l); if (!games) return [];
  return [...new Set(games.flatMap(g => [g.home, g.away]))].sort((a, b) => a.localeCompare(b, "lt"));
}
function teamGames(l) { return (scheduleFor(l) || []).filter(g => g.home === l.team || g.away === l.team); }
function teamField(l, i) {
  const teams = teamsFor(l);
  if (!teams.length || l.teamManual) return field(t("team"), input(`setup.leagues.${i}.team`, l.team, "text", `placeholder="${t("teamPh")}"`));
  const n = l.team ? teamGames(l).length : 0;
  return `${field(t("team"), `<select class="inp" data-f="setup.leagues.${i}.team"><option value="">${t("chooseTeam")}</option>${teams.map(x => `<option ${l.team === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`)}
    ${l.team ? `<span class="small" style="color:var(--green)">${ic("check", "width:16px;height:16px;vertical-align:-3px")} ${t("gamesFound", { n })}</span>` : ""}
    <button class="btn3" style="height:32px;font-size:13px;text-align:left" data-a="teamManual" data-i="${i}">${t("teamNotListed")}</button>`;
}
// Copies the chosen teams' games into the calendar and keeps them up to date.
// A game the user edited by hand is never overwritten.
function syncSchedules() {
  if (!ui.schedules) return 0;
  const today = todayKey(), seen = new Set(); let changed = 0;
  for (const l of state.setup.leagues) {
    if (l.source === "other" || !l.group || !l.team) continue;
    for (const g of teamGames(l)) {
      const id = "a:" + (g.url ? g.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "") : `${l.source}|${l.group}|${g.date}|${g.home}|${g.away}`);
      seen.add(id);
      const home = g.home === l.team, opponent = home ? g.away : g.home, league = `${l.source} ${l.group}`;
      const ex = state.games.find(x => x.id === id);
      if (!ex) { state.games.push({ id, auto: true, date: g.date, start: g.time, dur: 90, opponent, home, venue: g.venue, league, status: "planned" }); changed++; continue; }
      if (ex.userEdited) continue;
      if (ex.date !== g.date || ex.start !== g.time) {
        if (ex.date !== g.date && !ex.origDate) ex.origDate = ex.date;
        Object.assign(ex, { date: g.date, start: g.time, status: ex.origDate && ex.origDate !== g.date ? "postponed" : "planned" }); changed++;
      }
      Object.assign(ex, { venue: g.venue || ex.venue, opponent, home, league });
    }
  }
  // games that disappeared from the league schedule (and weren't edited) are removed
  const before = state.games.length;
  state.games = state.games.filter(g => !g.auto || g.userEdited || seen.has(g.id) || g.date < today);
  changed += before - state.games.length;
  state.schedulesUpdated = ui.schedules.updated;
  return changed;
}
async function loadSchedules() {
  try {
    const res = await fetch("data/schedules.json", { cache: "no-cache" });
    if (!res.ok) return;
    ui.schedules = await res.json();
    if (state.onboarded && !DEMO) syncSchedules();
    save(); render();
  } catch (e) { /* offline or not on GitHub Pages: manual games still work */ }
}

function gameForm() {
  const g = ui.newGame, leagues = state.setup.leagues.map(l => l.source === "other" ? l.name : l.source).filter(Boolean);
  const upcoming = [...state.games].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return `<div class="card">
    <span class="row bold" style="gap:8px">${ic("plus", "color:var(--volt);width:20px;height:20px")}${t("addGame")}</span>
    <p class="small muted" style="margin:0">${t("autoSoon")}</p>
    <div class="grid2">${field(t("date"), input("newGame.date", g.date, "date"))}${field(t("tipoff"), timeInput("newGame.start", g.start))}</div>
    ${field(t("opponent"), input("newGame.opponent", g.opponent, "text", `placeholder="${t("opponentPh")}"`))}
    ${seg("newGame.home", [["true", t("home")], ["false", t("away")]], String(g.home))}
    <div class="grid2">${field(t("venue"), input("newGame.venue", g.venue, "text", `placeholder="${t("venuePh")}"`))}
      ${field(t("league"), `<select class="inp" data-f="newGame.league"><option value="">—</option>${leagues.map(l => `<option ${g.league === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`)}</div>
    <button class="btn2" data-a="addGame">${ic("plus")} ${t("addGame")}</button>
    ${upcoming.length ? `<div class="col"><span class="label">${t("addedGames")}</span>${upcoming.map(x => `<div class="row between small"><span>${fmtShort(x.date)} · ${x.start} · ${x.home ? t("vs") : "@"} ${esc(x.opponent || "—")}</span>
      <button class="icon-btn plain" aria-label="${t("delete")}" data-a="removeGame" data-id="${x.id}">${ic("x", "width:18px;height:18px;color:var(--ink-muted)")}</button></div>`).join("")}</div>` : ""}
  </div>`;
}

function screenNotify() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const tip = (time, a, b) => `<div class="card tight row" style="flex-direction:row;align-items:flex-start"><span class="xs bold muted" style="width:44px;flex:none;padding-top:2px">${time}</span><span class="col" style="gap:2px"><span class="bold" style="font-size:15px">${a}</span><span class="small muted">${b}</span></span></div>`;
  return `<div class="scr">
    <div style="width:72px;height:72px;border-radius:16px;background:var(--volt);display:flex;align-items:center;justify-content:center;margin-top:40px;color:var(--black-900)">${ic("bell", "width:36px;height:36px")}</div>
    <h1 class="h1" style="font-size:40px">${esc(t("notifyTitle"))}</h1><p class="p">${t("notifyText")}</p>
    <div class="col" style="gap:10px">${tip("−30'", t("remindDay"), t("remindDaySub"))}${tip("20:00", t("remindGame"), t("remindGameSub"))}${tip("✓", t("remindCheck"), t("remindCheckSub"))}</div>
    <div class="grow"></div>
    ${!standalone && ios ? `<p class="small muted center" style="margin:0">${t("iosHint")}</p>` : ""}
    ${!standalone && ui.installEvt ? `<div class="card tight row" style="flex-direction:row">${ic("phone", "color:var(--volt)")}<span class="grow col" style="gap:2px"><span class="bold small">${t("androidInstall")}</span><span class="xs muted">${t("androidInstallSub")}</span></span><button class="btn2" style="width:auto;height:36px;padding:0 14px" data-a="install">${t("install")}</button></div>` : ""}
    <button class="btn" data-a="exportIcs">${ic("cal")} ${t("addToCal")}</button>
    <p class="xs muted center" style="margin:0">${t("icsNote")}</p>
    <button class="btn3" data-a="toMain">${t("notNow")}</button></div>`;
}

// ---------- 8. CALENDAR ----------
function viewSwitch() {
  return `<div class="seg" role="tablist">${[["day", t("viewDay")], ["week", t("viewWeek")], ["month", t("viewMonth")], ["year", t("viewYear")]].map(([v, l]) =>
    `<button role="tab" aria-selected="${ui.view === v}" class="${ui.view === v ? "on" : ""}" data-a="view" data-v="${v}">${l}</button>`).join("")}</div>`;
}
function navHeader(label, title) {
  return `<div class="row between">
    <button class="icon-btn" aria-label="${t("back")}" data-a="nav" data-v="-1">${ic("back", "width:20px;height:20px")}</button>
    <button class="col center" style="gap:2px;align-items:center;background:none;border:0;color:inherit" data-a="goToday"><span class="label">${label}</span><span class="h2">${title}</span></button>
    <button class="icon-btn" aria-label="${t("next")}" data-a="nav" data-v="1">${ic("fwd", "width:20px;height:20px")}</button></div>`;
}
function sessionCard(i) {
  const l = state.log[i.id], g = i.game;
  const meta = i.type === "game"
    ? `${t("types").game} · ${g.home ? t("home") : t("away")}${g.league ? " · " + esc(g.league) : ""}`
    : `${t("typesShort")[i.type]} · ${hm(i.dur)}`;
  const extra = i.type === "game" && g.status === "postponed" && g.origDate ? `<span class="xs" style="color:var(--volt)">${t("postponed", { d: fmtShort(g.origDate) })}</span>` : "";
  const sub = i.type === "game" && g.venue ? `<span class="small muted">${esc(g.venue)}</span>` : i.type === "sc" && state.setup.sc.fileName ? `<span class="small muted">${t("planFile", { f: esc(state.setup.sc.fileName) })}</span>` : i.type === "skills" && state.setup.skills.focus ? `<span class="small muted">${esc(state.setup.skills.focus)}</span>` : "";
  const right = i.cancelled ? `<span class="xs muted">${t("cancelled")}</span>` : l ? ic("check", "color:var(--green)") : "";
  return `<div class="sess"><span class="time">${i.start}</span>
    <button class="box ${i.type === "game" ? "game" : ""} ${i.cancelled ? "cancel" : ""} ${l ? "done" : ""}" data-a="openItem" data-id="${esc(i.id)}" data-k="${i.date}">
      <span class="grow col" style="gap:4px"><span class="meta"><span class="dot ${i.type === "game" ? "game" : i.type === "recovery" ? "recovery" : ""}"></span>${meta}</span>
      <span class="t">${esc(itemTitle(i))}</span>${sub}${extra}</span>${right}</button></div>`;
}
function viewDay() {
  const k = ui.cursor, p = dayPlan(k), tk = todayKey();
  const label = k === tk ? t("today") : k === addDays(tk, 1) ? t("tomorrow") : t("weekdays")[parse(k).getDay()];
  let banner = "";
  if (k === tk) {
    const due = p.active.find(i => !state.log[i.id] && toMin(i.start) + i.dur <= nowMin());
    if (due) banner = `<div class="card volt row" style="flex-direction:row;padding:14px 16px"><span class="grow col" style="gap:2px"><span class="bold" style="font-size:15px">${t("checkinBanner", { name: esc(itemTitle(due)) })}</span><span class="small">${t("checkinBannerSub")}</span></span>
      <button class="btn dark" style="width:auto;padding:0 16px" data-a="openCheckin" data-id="${esc(due.id)}" data-k="${k}">${t("checkin")}</button></div>`;
  }
  const next = dayPlan(addDays(k, 1)).active.find(i => i.type === "game");
  return `<div class="row between"><div class="col" style="gap:4px"><span class="label">${fmtShort(k)} · ${t("week", { n: isoWeek(k) })}</span><h1 class="h1" style="font-size:40px">${label}</h1></div>
      <button class="icon-btn volt" aria-label="${t("addSession")}" data-a="openAdd" data-k="${k}" style="color:var(--black-900)">${ic("plus")}</button></div>
    ${viewSwitch()}
    <div class="row between"><button class="btn3 volt" data-a="nav" data-v="-1">‹ ${fmtShort(addDays(k, -1))}</button><button class="btn3 volt" data-a="nav" data-v="1">${fmtShort(addDays(k, 1))} ›</button></div>
    ${banner}
    ${p.items.length ? `<div class="col" style="gap:10px">${p.items.map(sessionCard).join("")}</div>`
      : `<div class="card row" style="flex-direction:row">${ic("moon", "color:var(--ink-muted)")}<span class="bold">${p.rest ? (p.restReason === "after" ? t("restAfterGame") : t("restDay")) : t("nothingPlanned")}</span></div>`}
    ${next ? `<div class="col"><span class="label">${t("tomorrow")}</span><button class="card row" style="flex-direction:row;border-color:var(--volt);text-align:left;color:inherit" data-a="day" data-k="${next.date}">${ic("trophy", "color:var(--volt)")}
      <span class="col" style="gap:2px"><span class="bold" style="font-size:15px">${esc(itemTitle(next))}</span><span class="small muted">${next.game.home ? t("home") : t("away")} · ${t("tipoff")} ${next.start}</span></span></button></div>` : ""}`;
}
function viewWeek() {
  const mon = mondayOf(ui.cursor), sun = addDays(mon, 6), st = weekStats(mon), lim = hourLimit(), tk = todayKey();
  const rows = Array.from({ length: 7 }, (_, n) => {
    const k = addDays(mon, n), p = dayPlan(k), d = parse(k), isT = k === tk;
    const pills = p.items.map(i => {
      const cls = i.cancelled ? "x" : i.type === "game" ? "game" : "";
      return `<span class="pill ${cls}">${i.type !== "game" ? `<span class="dot ${i.type === "recovery" ? "recovery" : ""}" style="width:7px;height:7px"></span>` : ""}${i.type === "game" ? `${t("typesShort").game} ${i.start} · ${i.game.home ? t("home") : t("away")}` : `${t("typesShort")[i.type]} ${i.start}`}</span>`;
    }).join("") || `<span class="pill rest">${p.rest && p.restReason === "after" ? t("restAfterGame") : t("restDay")}</span>`;
    return `<button class="li" data-a="day" data-k="${k}" style="color:inherit"><span class="col" style="gap:0;width:40px;flex:none"><span class="xs ${isT ? "bold" : "muted"}" style="${isT ? "color:var(--volt)" : ""}">${t("wdShort")[d.getDay()]}</span>
      <span style="font-family:var(--display);font-weight:700;font-size:22px;line-height:1;${isT ? "color:var(--volt)" : ""}">${d.getDate()}</span></span><span class="chips">${pills}</span></button>`;
  }).join("");
  const pct = lim ? Math.min(100, st.planned / (lim * 60) * 100) : Math.min(100, st.planned / (16 * 60) * 100);
  const over = lim && st.planned > lim * 60;
  return `${navHeader(t("week", { n: isoWeek(mon) }), `${fmtShort(mon)} – ${fmtShort(sun)}`)}${viewSwitch()}
    <div class="card tight"><div class="row between small"><span class="muted">${t("plannedWeek")}</span><span class="bold num ${over ? "bad" : ""}">${hm(st.planned)} ${lim ? `<span class="muted" style="font-weight:400">${t("maxHours", { n: lim })}</span>` : ""}</span></div>
      <div class="bar"><b class="${over ? "over" : ""}" style="width:${pct}%"></b></div></div>
    <div class="list">${rows}</div>`;
}
function viewMonth() {
  const d = parse(ui.cursor), y = d.getFullYear(), m = d.getMonth(), first = new Date(y, m, 1), tk = todayKey();
  const lead = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
  let cells = Array.from({ length: lead }, () => "<span></span>");
  for (let n = 1; n <= dim; n++) {
    const k = keyOf(new Date(y, m, n)), p = dayPlan(k);
    const dots = p.active.slice(0, 3).map(i => `<i class="${i.type === "game" ? "g" : ""}"></i>`).join("");
    cells.push(`<button class="${k < tk ? "past" : ""} ${k === ui.cursor ? "sel" : ""} ${k === tk ? "today" : ""}" data-a="pick" data-k="${k}" aria-label="${n}"><span class="n">${n}</span><span class="dots">${dots}</span></button>`);
  }
  const p = dayPlan(ui.cursor);
  return `${navHeader(String(y), t("months")[m])}${viewSwitch()}
    <div class="card" style="padding:12px 8px"><div class="month">${WEEK_ORDER.map(w => `<span class="wd">${t("wdLetter")[w]}</span>`).join("")}${cells.join("")}</div></div>
    <div class="row xs muted" style="gap:16px;padding:0 4px"><span class="row" style="gap:6px"><span class="dot game"></span>${t("legendGame")}</span><span class="row" style="gap:6px"><span class="dot"></span>${t("legendTraining")}</span><span>${t("legendRest")}</span></div>
    <button class="card tight" style="text-align:left;color:inherit" data-a="day" data-k="${ui.cursor}"><span class="label">${fmtDay(ui.cursor)}</span>
      <span style="font-size:15px">${p.active.map(i => `${esc(itemTitle(i))} ${i.start}`).join(" · ") || (p.rest ? t("restDay") : t("nothingPlanned"))}</span></button>`;
}
function weekLevel(mon) {
  const m = weekStats(mon).planned, lim = (hourLimit() || 16) * 60;
  return m === 0 ? 0 : m < lim * 0.35 ? 1 : m <= lim * 0.85 ? 2 : 3;
}
function viewYear() {
  const d = parse(ui.cursor), sy = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1, cur = todayKey().slice(0, 7);
  let offWeeks = 0;
  const cards = Array.from({ length: 12 }, (_, n) => {
    const md = new Date(sy, 8 + n, 1), ym = keyOf(md).slice(0, 7);
    let mon = mondayOf(keyOf(md)); if (parse(mon).getMonth() !== md.getMonth()) mon = addDays(mon, 7);
    const lv = []; while (parse(mon).getMonth() === md.getMonth()) { const l = weekLevel(mon); if (l === 0 && state.startDate && mon >= state.startDate) offWeeks++; lv.push(l); mon = addDays(mon, 7); }
    return `<button class="${ym === cur ? "cur" : ""}" data-a="month" data-k="${keyOf(md)}"><span class="col" style="gap:1px"><span class="mn">${t("monthsShort")[md.getMonth()].replace(".", "")}</span></span>
      <span class="wk">${lv.map(l => `<i class="l${l}"></i>`).join("")}</span></button>`;
  }).join("");
  const ok = offWeeks >= 4;
  return `${navHeader(t("seasonLabel"), `${sy} / ${String(sy + 1).slice(2)}`)}${viewSwitch()}
    <div class="year">${cards}</div>
    <div class="row xs muted" style="gap:12px;flex-wrap:wrap;padding:0 4px">${t("weeklyLoad")} ${[0, 1, 2, 3].map(l => `<span class="row" style="gap:6px"><span class="wk" style="width:10px"><i class="l${l}" style="height:10px;${l === 0 ? "border:1px solid var(--ink-muted)" : ""}"></i></span>${t("phase")[["off", "light", "normal", "heavy"][l]]}</span>`).join("")}</div>
    ${state.startDate ? `<div class="card row" style="flex-direction:row">${ic(ok ? "check" : "alert", `color:var(--${ok ? "green" : "danger"})`)}<span class="col" style="gap:2px"><span class="bold" style="font-size:15px">${t(ok ? "breakOk" : "breakLow", { n: offWeeks })}</span><span class="small muted">${t("breakOkSub")}</span></span></div>` : ""}`;
}
function screenCalendar() { return ({ day: viewDay, week: viewWeek, month: viewMonth, year: viewYear })[ui.view](); }

// ---------- 9. LOAD ----------
function screenLoad() {
  const mon = ui.loadWeek, st = weekStats(mon), lim = hourLimit(), ratio = acwr(mon);
  const hoursFlag = lim !== null && st.planned > lim * 60, spikeFlag = ratio !== null && ratio > 1.3, restFlag = st.daysOff < 1, painFlag = st.pains.length > 0;
  const tile = (label, value, sub, flag, neutral) => `<div class="tile ${flag ? "flag" : ""}"><span class="row between xs muted">${label}${neutral ? "" : ic(flag ? "alert" : "check", `width:16px;height:16px;color:var(--${flag ? "danger" : "green"})`)}</span><span class="v">${value}</span><span class="xs muted">${sub}</span></div>`;
  const weeks = [5, 4, 3, 2, 1, 0].map(n => { const m = addDays(mon, -7 * n), s = weekStats(m); return { m, v: s.load || 0 }; });
  const max = Math.max(1, ...weeks.map(w => w.v));
  const areas = [...new Set(st.pains.filter(Boolean))].map(a => t("areas")[a] || a).join(", ");
  const tips = [hoursFlag && t("suggestHours"), spikeFlag && t("suggestSpike"), painFlag && t("suggestPain"), restFlag && t("suggestRest")].filter(Boolean);
  return `${navLoad(mon)}
    <div class="tiles">
      ${tile(t("hoursWeek"), hm(st.planned), lim !== null ? t("hoursLimit", { n: lim }) : t("hoursNoLimit"), hoursFlag, lim === null)}
      ${tile(t("spike"), ratio === null ? "—" : ratio.toFixed(1).replace(".", state.lang === "lt" ? "," : ".") + "×", ratio === null ? t("notEnough") : t("spikeSub"), spikeFlag, ratio === null)}
      ${tile(t("daysOff"), st.daysOff, t("daysOffSub"), restFlag)}
      ${tile(t("pain"), st.pains.length ? `${areas || "—"} · ${st.pains.length}` : "0", st.pains.length ? "" : t("painNone"), painFlag)}
    </div>
    <div class="card tight"><span class="row between xs muted"><span class="label">${t("weeklyLoadChart")}</span><span>${t("effortXmin")}</span></span>
      <div class="bars">${weeks.map((w, i) => `<span class="${i === 5 ? "last" : ""} ${i === 5 && spikeFlag ? "flagged" : ""}"><span class="num">${w.v || ""}</span><b style="height:${Math.round(w.v / max * 90)}px"></b><span>${isoWeek(w.m)}</span></span>`).join("")}</div>
      ${st.logged === 0 ? `<span class="xs muted">${t("checkinsHint")}</span>` : ""}</div>
    ${tips.length ? `<div class="card volt" style="gap:10px">${tips.map(x => `<span class="small">${x}</span>`).join("")}<button class="btn dark" data-a="openWeek" data-k="${mon}">${t("openWeek")}</button></div>`
      : `<div class="card row" style="flex-direction:row">${ic("check", "color:var(--green)")}<span class="bold">${t("allGood")}</span></div>`}
    <p class="xs muted" style="margin:0;padding:0 4px">${t("disclaimer")}</p>`;
}
function navLoad(mon) {
  return `<div class="row between">
    <button class="icon-btn" aria-label="${t("back")}" data-a="loadNav" data-v="-1">${ic("back", "width:20px;height:20px")}</button>
    <div class="col center" style="gap:2px;align-items:center"><span class="label">${t("week", { n: isoWeek(mon) })} · ${fmtShort(mon)} – ${fmtShort(addDays(mon, 6))}</span><span class="h2">${t("loadTitle")}</span></div>
    <button class="icon-btn" aria-label="${t("next")}" data-a="loadNav" data-v="1">${ic("fwd", "width:20px;height:20px")}</button></div>`;
}

// ---------- 10. TESTS ----------
function screenTests() {
  const J = state.tests.jumps, last8 = J.slice(-8), H = state.tests.heights;
  const max = Math.max(...last8.map(j => j.best), 1), min = Math.min(...last8.map(j => j.best), max) - 20;
  let warn = "";
  if (J.length >= 3) {
    const lastJ = J[J.length - 1], prev = J.slice(-5, -1), avg = prev.reduce((a, b) => a + b.best, 0) / prev.length;
    const drop = Math.round((1 - lastJ.best / avg) * 100);
    if (drop >= 5) warn = `<div class="card flag row" style="flex-direction:row;align-items:flex-start">${ic("alert", "color:var(--danger);width:20px;height:20px")}<span class="small"><span class="bold">${t("jumpDrop", { p: drop })}</span> <span class="muted">${t("jumpDropSub")}</span></span></div>`;
  }
  const best = Math.max(0, ...ui.jump.map(Number).filter(Boolean));
  const lastH = H[H.length - 1], oldH = H.find(h => h.date >= addDays(todayKey(), -100));
  const change = lastH && oldH && lastH !== oldH ? (lastH.cm - oldH.cm) : null;
  return `<div class="col" style="gap:4px"><span class="label">${t("weeklyTest")} · ${fmtShort(todayKey())}</span><h1 class="h1" style="font-size:36px">${t("broadJump")}</h1></div>
    <div class="card"><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${[0, 1, 2].map(n => field(t("jumpN", { n: n + 1 }), `<input class="inp center bold" type="number" inputmode="numeric" min="0" max="400" data-f="jump.${n}" value="${esc(ui.jump[n])}">`)).join("")}</div>
      <div class="row between"><span class="small muted">${t("bestToday")}</span><span style="font-family:var(--display);font-weight:700;font-size:32px;line-height:1;color:var(--volt)">${best || "—"}</span></div>
      <button class="btn2" data-a="saveJump">${t("saveResult")}</button></div>
    <div class="card tight"><span class="label">${t("last8")}</span>
      ${last8.length ? `<div class="bars">${last8.map((j, i) => `<span class="${i === last8.length - 1 ? "last" : ""}"><span class="num">${j.best}</span><b style="height:${Math.max(6, Math.round((j.best - min) / (max - min || 1) * 90))}px"></b><span>${fmtShort(j.date)}</span></span>`).join("")}</div>` : `<span class="small muted">${t("noResults")}</span>`}</div>
    ${warn}
    <p class="xs muted" style="margin:0;padding:0 4px">${t("jumpHow")}</p>
    <div class="card"><div class="row between"><span class="col" style="gap:2px"><span class="bold" style="font-size:15px">${t("heightMonthly")}</span>${change !== null ? `<span class="small muted">${t("heightChange", { c: (change > 0 ? "+" : "") + change })}</span>` : ""}</span>
      <span style="font-family:var(--display);font-weight:700;font-size:24px">${lastH ? lastH.cm + " cm" : "—"}</span></div>
      <div class="row">${`<input class="inp" type="number" inputmode="decimal" min="50" max="250" placeholder="${t("heightCm")}" data-f="heightIn" value="${esc(ui.heightIn)}">`}<button class="btn2" style="width:auto;padding:0 18px" data-a="saveHeight">${t("save")}</button></div>
      ${change !== null && change >= 2 ? `<span class="small" style="color:var(--volt)">${t("growthNote")}</span>` : ""}</div>`;
}

// ---------- 11. PROFILE ----------
function screenProfile() {
  const p = state.setup.profile, age = ageOn(p.dob);
  const item = (icon, label, action, extra = "", cls = "") => `<button class="li ${cls}" data-a="${action}" style="color:${cls === "danger" ? "var(--danger)" : "inherit"}">${ic(icon, "width:20px;height:20px")}<span class="grow" style="font-size:15px">${label}</span>${extra}</button>`;
  return `<div class="col" style="gap:4px"><span class="label">${t("sports")[p.sport]}${age !== null ? " · " + t("ageN", { n: age }) : ""}</span><h1 class="h1" style="font-size:40px">${t("profileTitle")}</h1></div>
    <div class="list">
      ${item("refresh", t("editSetup"), "editSetup", ic("fwd", "width:18px;height:18px;color:var(--ink-muted)"))}
      ${item("cal", t("addToCal"), "exportIcs")}
      ${ui.schedules ? item("refresh", t("updateNow"), "refreshSchedules", `<span class="xs muted">${t("schedulesUpdated", { d: fmtShort(keyOf(new Date(ui.schedules.updated))) })}</span>`) : ""}
      <div class="li">${ic("globe", "width:20px;height:20px")}<span class="grow" style="font-size:15px">${t("language")}</span><div style="width:150px">${seg("lang", [["lt", "LT"], ["en", "EN"]], state.lang)}</div></div>
      ${FEEDBACK_URL ? `<a class="li" href="${FEEDBACK_URL}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${ic("msg", "width:20px;height:20px")}<span class="grow" style="font-size:15px">${t("feedback")}</span></a>` : ""}
      ${item("bell", t("reminders"), "openReminders", ic("fwd", "width:18px;height:18px;color:var(--ink-muted)"))}
      ${item("lock", t("privacy"), "privacy")}
      ${item("trash", t("resetData"), "resetAsk", "", "danger")}
    </div>
    <p class="xs muted center" style="margin:0">${t("version", { v: VERSION })}${DEMO ? " · DEMO" : ""}</p>`;
}

// ---------- 12. SHEETS (pop-ups from the bottom) ----------
function sheetHtml() {
  const s = ui.sheet; if (!s) return "";
  let body = "";
  const f = ui.form;
  if (s.kind === "add") {
    const types = ["game", "team", "skills", "sc", "recovery", "other"];
    body = `<div class="row between"><span class="h2">${t("addSession")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div>
      ${field(t("type"), `<select class="inp" data-f="form.type">${types.map(x => `<option value="${x}" ${f.type === x ? "selected" : ""}>${t("types")[x]}</option>`).join("")}</select>`)}
      <div class="grid2">${field(t("date"), input("form.date", f.date, "date"))}${field(t("start"), timeInput("form.start", f.start))}</div>
      ${f.type === "game" ? `${field(t("opponent"), input("form.opponent", f.opponent, "text", `placeholder="${t("opponentPh")}"`))}${seg("form.home", [["true", t("home")], ["false", t("away")]], String(f.home))}${field(t("venue"), input("form.venue", f.venue, "text"))}`
        : `${field(t("duration"), durSelect("form.dur", f.dur))}${f.type === "other" ? field(t("title"), input("form.title", f.title, "text")) : ""}`}
      <button class="btn" data-a="saveAdd">${t("save")}</button>`;
  }
  if (s.kind === "game") {
    body = `<div class="row between"><span class="label">${t("editGame")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div>
      ${seg("form.status", [["planned", t("statusPlanned")], ["postponed", t("statusPostponed")], ["cancelled", t("statusCancelled")]], f.status, "volt")}
      ${field(t("opponent"), input("form.opponent", f.opponent, "text"))}
      <div class="grid2">${field(f.status === "postponed" ? t("newDate") : t("date"), input("form.date", f.date, "date"))}${field(t("tipoff"), timeInput("form.start", f.start))}</div>
      ${seg("form.home", [["true", t("home")], ["false", t("away")]], String(f.home))}
      ${field(t("venue"), input("form.venue", f.venue, "text"))}
      <p class="small muted" style="margin:0">${t("replanNote")}</p>
      <button class="btn" data-a="saveGame">${t("save")}</button>
      ${state.log[f.id] || f.date <= todayKey() ? `<button class="btn2" data-a="openCheckin" data-id="${esc(f.id)}" data-k="${f.date}">${t("checkin")}</button>` : ""}
      <button class="btn3 danger" data-a="deleteGame">${t("delete")}</button>`;
  }
  if (s.kind === "session") {
    const it = findItem(s.id, s.k);
    body = `<div class="row between"><span class="label">${t("editSession")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div>
      <span class="h2">${esc(itemTitle(it))}</span><span class="small muted">${fmtDay(s.k)}</span>
      <div class="grid2">${field(t("start"), timeInput("form.start", f.start))}${field(t("duration"), durSelect("form.dur", f.dur))}</div>
      <button class="btn" data-a="saveSession">${t("save")}</button>
      ${!it.cancelled && s.k <= todayKey() ? `<button class="btn2" data-a="openCheckin" data-id="${esc(s.id)}" data-k="${s.k}">${t("checkin")}</button>` : ""}
      <button class="btn3 ${it.cancelled ? "" : "danger"}" data-a="toggleCancel">${it.cancelled ? t("restoreThis") : it.kind === "custom" ? t("delete") : t("cancelThis")}</button>`;
  }
  if (s.kind === "checkin") {
    const it = findItem(s.id, s.k);
    const rpe = f.rpe ? `${f.rpe} × ${it.dur} ${t("min")} = ${f.rpe * it.dur}` : "—";
    body = `<div class="row between"><span class="label">${t("checkinLabel")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div>
      <div class="col" style="gap:4px"><span class="h1">${t("howHard")}</span><span class="small muted">${esc(itemTitle(it))} · ${fmtShort(s.k)} · ${hm(it.dur)}</span></div>
      <div class="col"><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px" role="radiogroup">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button class="chip ${f.rpe === n ? "on volt" : ""}" style="height:48px;font-size:17px" role="radio" aria-checked="${f.rpe === n}" data-a="set" data-p="form.rpe" data-v="${n}" data-t="num">${n}</button>`).join("")}</div>
        <div class="row between xs muted"><span>${t("rpe1")}</span><span>${t("rpe5")}</span><span>${t("rpe10")}</span></div></div>
      ${it.type === "game" ? `<label class="card tight row" style="flex-direction:row"><span class="grow col" style="gap:2px"><span class="bold" style="font-size:15px">${t("minutesPlayed")}</span><span class="small muted">${t("gamesOnly")}</span></span>
        <input class="inp center bold" style="width:80px" type="number" inputmode="numeric" min="0" max="60" data-f="form.minutes" value="${esc(f.minutes)}"></label>` : ""}
      <div class="card"><div class="row between"><span class="bold" style="font-size:15px">${t("anyPain")}</span><div style="width:140px">${seg("form.pain", [["false", t("no")], ["true", t("yes")]], String(!!f.pain))}</div></div>
        ${f.pain ? `<div class="chips">${Object.entries(t("areas")).map(([k, v]) => `<button class="chip ${f.area === k ? "on white" : ""}" data-a="set" data-p="form.area" data-v="${k}">${v}</button>`).join("")}</div><span class="small muted">${t("painNote")}</span>` : ""}</div>
      <div class="row between small muted"><span>${t("sessionLoad")}</span><span class="num" style="color:var(--ink)">${rpe}</span></div>
      ${ui.error ? `<p class="err">${esc(ui.error)}</p>` : ""}
      <button class="btn" data-a="saveCheckin">${t("saveCheckin")}</button>`;
  }
  if (s.kind === "reminders") {
    const R = state.reminders, opts = [0, 15, 30, 60, 120, 180];
    const rowR = type => `<div class="card tight" style="gap:10px"><span class="row bold" style="gap:8px;font-size:15px">${ic(typeIcon[type], `color:var(--${type === "game" ? "volt" : "green"});width:20px;height:20px`)}${t("types")[type]}</span>
      <div class="grid2">${field(t("rBefore"), `<select class="inp" data-f="rem.${type}.before" data-t="num">${opts.map(o => `<option value="${o}" ${R[type].before === o ? "selected" : ""}>${o === 0 ? t("rNone") : o < 60 ? o + " " + t("min") : hm(o)}</option>`).join("")}</select>`)}
        <label class="check" style="min-height:44px;align-self:end"><input type="checkbox" data-f="rem.${type}.eve" ${R[type].eve ? "checked" : ""}><span class="small">${t("rEve")}</span></label></div></div>`;
    body = `<div class="row between"><span class="h2">${t("reminders")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div>
      <p class="small muted" style="margin:0">${t("remindersSub")}</p>
      ${["game", "team", "sc", "skills", "recovery", "other"].map(rowR).join("")}
      <div class="grid2">${field(t("eveTime"), `<input class="inp" type="time" data-f="rem.eveTime" value="${esc(R.eveTime)}">`)}
        <label class="check" style="min-height:44px;align-self:end"><input type="checkbox" data-f="rem.quiet" ${R.quiet ? "checked" : ""}><span class="small">${t("quietHours")}<span class="sub">22:00–07:00</span></span></label></div>
      <p class="xs muted" style="margin:0">${t("remindersNote")}</p>
      <button class="btn" data-a="exportIcs">${ic("cal")} ${t("addToCal")}</button>
      <button class="btn3" data-a="resetReminders">${t("recommended")}</button>`;
  }
  if (s.kind === "privacy") {
    body = `<div class="row between"><span class="h2">${t("privacy")}</span><button class="icon-btn plain" aria-label="${t("close")}" data-a="closeSheet">${ic("x")}</button></div><p class="p" style="color:var(--ink)">${t("privacyFull")}</p>`;
  }
  if (s.kind === "reset") {
    body = `<span class="h2">${t("resetData")}</span><p class="p">${t("resetConfirm")}</p>
      <button class="btn" style="background:var(--danger)" data-a="resetDo">${t("delete")}</button><button class="btn3" data-a="closeSheet">${t("cancel")}</button>`;
  }
  return `<div class="sheet-bg" data-a="bgClose"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${body}</div></div>`;
}

// ---------- 13. DRAW ----------
function render() {
  document.documentElement.lang = state.lang;
  const app = document.getElementById("app");
  let html = "";
  if (ui.screen === "welcome") html = screenWelcome();
  else if (ui.screen === "onb") html = screenOnboarding();
  else if (ui.screen === "notify") html = screenNotify();
  else {
    const inner = ({ cal: screenCalendar, load: screenLoad, tests: screenTests, profile: screenProfile })[ui.tab]();
    html = `<div class="scr with-tabs">${inner}</div>${tabbar()}`;
  }
  const scroll = document.querySelector(".sheet")?.scrollTop;
  app.innerHTML = html + sheetHtml();
  if (scroll) document.querySelector(".sheet") && (document.querySelector(".sheet").scrollTop = scroll);
}

// ---------- 14. READING AND WRITING VALUES BY "PATH" ----------
// e.g. "setup.practice.start" → state.setup.practice.start
function rootFor(path) {
  const [head, ...rest] = path.split(".");
  const roots = { setup: state.setup, form: ui.form, newGame: ui.newGame, jump: ui.jump, lang: state, heightIn: ui, rem: state.reminders };
  return { obj: roots[head], rest: head === "lang" ? ["lang"] : head === "heightIn" ? ["heightIn"] : rest };
}
function setPath(path, value) {
  const { obj, rest } = rootFor(path);
  let o = obj; for (let i = 0; i < rest.length - 1; i++) o = o[rest[i]];
  o[rest[rest.length - 1]] = value;
}
function getPath(path) { const { obj, rest } = rootFor(path); return rest.reduce((o, k) => o?.[k], obj); }
function coerce(v, type) {
  if (v === "true") return true; if (v === "false") return false;
  if (type === "num") return v === "" ? "" : Number(v);
  if (/^\d+$/.test(v) && type !== "text") return Number(v);
  return v;
}

// ---------- 15. ACTIONS (what each button does) ----------
const actions = {
  start() { ui.screen = "onb"; ui.step = 1; ui.editing = false; },
  set(el) { setPath(el.dataset.p, coerce(el.dataset.v, el.dataset.t)); if (el.dataset.p === "form.pain" && !ui.form.pain) ui.form.area = ""; },
  toggleDay(el) {
    const arr = getPath(el.dataset.p), d = Number(el.dataset.d), i = arr.indexOf(d);
    i >= 0 ? arr.splice(i, 1) : arr.push(d);
  },
  next() {
    ui.error = "";
    if (STEPS[ui.step - 1] === "about" && !state.setup.profile.dob) { ui.error = t("needDob"); return; }
    if (STEPS[ui.step - 1] === "rest" && !state.setup.rest.seasonEnd) state.setup.rest.seasonEnd = seasonEnd(todayKey());
    ui.step = Math.min(STEPS.length, ui.step + 1); scrollTo(0, 0);
  },
  back() { ui.error = ""; if (ui.step > 1) ui.step--; else ui.screen = ui.editing ? "main" : "welcome"; scrollTo(0, 0); },
  goStep(el) { ui.step = Number(el.dataset.v); ui.error = ""; scrollTo(0, 0); },
  showManual() { ui.showManual = true; },
  teamManual(el) { state.setup.leagues[Number(el.dataset.i)].teamManual = true; },
  async refreshSchedules() { await loadSchedules(); },
  addLeague() { if (state.setup.leagues.length < 3) state.setup.leagues.push({ source: "MKL", group: "", team: "", name: "", url: "" }); },
  removeLeague(el) { state.setup.leagues.splice(Number(el.dataset.i), 1); },
  addGame() {
    const g = ui.newGame; if (!g.date) return;
    state.games.push({ id: "g" + uid(), date: g.date, start: g.start || "18:00", dur: 90, opponent: g.opponent.trim(), home: g.home !== false, venue: g.venue.trim(), league: g.league, status: "planned" });
    Object.assign(ui.newGame, { opponent: "", venue: "", date: addDays(g.date, 7) });
  },
  removeGame(el) { state.games = state.games.filter(g => g.id !== el.dataset.id); },
  finish() {
    const p = state.setup.profile, age = ageOn(p.dob);
    if (age !== null && age < 18 && !p.parentOk) { ui.error = t("needParent"); return; }
    if (!state.startDate) state.startDate = mondayOf(todayKey());
    syncSchedules();
    state.endDate = state.setup.rest.seasonEnd || seasonEnd(todayKey());
    const wasEditing = ui.editing;
    state.onboarded = true; ui.error = ""; ui.editing = false;
    ui.screen = wasEditing ? "main" : "notify"; ui.tab = "cal"; ui.view = "day"; ui.cursor = todayKey();
  },
  toMain() { ui.screen = "main"; ui.tab = "cal"; ui.view = "day"; ui.cursor = todayKey(); },
  async install() { if (ui.installEvt) { ui.installEvt.prompt(); await ui.installEvt.userChoice; ui.installEvt = null; render(); } },
  exportIcs() { downloadIcs(); },
  tab(el) { ui.tab = el.dataset.v; if (ui.tab === "load") ui.loadWeek = mondayOf(todayKey()); scrollTo(0, 0); },
  view(el) { ui.view = el.dataset.v; },
  nav(el) {
    const n = Number(el.dataset.v), d = parse(ui.cursor);
    if (ui.view === "day") ui.cursor = addDays(ui.cursor, n);
    if (ui.view === "week") ui.cursor = addDays(ui.cursor, 7 * n);
    if (ui.view === "month") ui.cursor = keyOf(new Date(d.getFullYear(), d.getMonth() + n, 1));
    if (ui.view === "year") ui.cursor = keyOf(new Date(d.getFullYear() + n, d.getMonth(), 1));
  },
  goToday() { ui.cursor = todayKey(); },
  day(el) { ui.cursor = el.dataset.k; ui.view = "day"; ui.tab = "cal"; scrollTo(0, 0); },
  pick(el) { ui.cursor = el.dataset.k; },
  month(el) { ui.cursor = el.dataset.k; ui.view = "month"; },
  openWeek(el) { ui.tab = "cal"; ui.view = "week"; ui.cursor = el.dataset.k; },
  loadNav(el) { ui.loadWeek = addDays(ui.loadWeek, 7 * Number(el.dataset.v)); },
  openAdd(el) { ui.form = { type: "team", date: el.dataset.k || ui.cursor, start: "17:00", dur: 60, opponent: "", home: true, venue: "", title: "" }; ui.sheet = { kind: "add" }; },
  saveAdd() {
    const f = ui.form; if (!f.date) return;
    if (f.type === "game") state.games.push({ id: "g" + uid(), date: f.date, start: f.start, dur: 90, opponent: f.opponent.trim(), home: f.home !== false, venue: f.venue.trim(), league: "", status: "planned" });
    else state.custom.push({ id: "c" + uid(), date: f.date, start: f.start, dur: Number(f.dur), type: f.type, title: f.type === "other" ? f.title.trim() : "" });
    ui.cursor = f.date; ui.sheet = null;
  },
  openItem(el) {
    const it = findItem(el.dataset.id, el.dataset.k); if (!it) return;
    if (it.kind === "game") { const g = it.game; ui.form = { ...g, home: g.home }; ui.sheet = { kind: "game", id: g.id }; }
    else { ui.form = { start: it.start, dur: it.dur }; ui.sheet = { kind: "session", id: it.id, k: it.date }; }
  },
  saveGame() {
    const f = ui.form, g = state.games.find(x => x.id === f.id); if (!g) return;
    g.userEdited = true;
    if (f.date !== g.date && !g.origDate) g.origDate = g.date;
    Object.assign(g, { date: f.date, start: f.start, opponent: f.opponent, home: f.home !== false, venue: f.venue, status: f.status });
    if (g.status === "planned" && g.origDate === g.date) delete g.origDate;
    ui.cursor = g.date; ui.sheet = null;
  },
  deleteGame() { state.games = state.games.filter(g => g.id !== ui.form.id); delete state.log[ui.form.id]; ui.sheet = null; },
  saveSession() {
    const s = ui.sheet, it = findItem(s.id, s.k);
    if (it.kind === "custom") Object.assign(it.custom, { start: ui.form.start, dur: Number(ui.form.dur) });
    else state.over[s.id] = { ...(state.over[s.id] || {}), start: ui.form.start, dur: Number(ui.form.dur) };
    ui.sheet = null;
  },
  toggleCancel() {
    const s = ui.sheet, it = findItem(s.id, s.k);
    if (it.kind === "custom") { state.custom = state.custom.filter(c => c.id !== it.id); delete state.log[it.id]; }
    else { const o = state.over[s.id] || {}; o.cancelled = !o.cancelled; state.over[s.id] = o; }
    ui.sheet = null;
  },
  openCheckin(el) {
    const id = el.dataset.id, k = el.dataset.k, l = state.log[id] || {};
    ui.form = { rpe: l.rpe || 0, minutes: l.minutes ?? "", pain: !!l.pain, area: l.area || "" };
    ui.sheet = { kind: "checkin", id, k }; ui.error = "";
  },
  saveCheckin() {
    const f = ui.form, s = ui.sheet, it = findItem(s.id, s.k);
    if (!f.rpe) { ui.error = t("pickRpe"); return; }
    state.log[s.id] = { rpe: f.rpe, minutes: f.minutes === "" ? null : Number(f.minutes), pain: !!f.pain, area: f.pain ? f.area : "", dur: it.dur, type: it.type, date: s.k };
    ui.sheet = null; ui.error = "";
  },
  saveJump() {
    const vals = ui.jump.map(Number).filter(v => v > 0); if (!vals.length) return;
    const k = todayKey(), J = state.tests.jumps.filter(j => j.date !== k);
    J.push({ date: k, vals, best: Math.max(...vals) }); J.sort((a, b) => a.date.localeCompare(b.date));
    state.tests.jumps = J; ui.jump = ["", "", ""];
  },
  saveHeight() {
    const v = Number(String(ui.heightIn).replace(",", ".")); if (!v) return;
    const k = todayKey(), H = state.tests.heights.filter(h => h.date !== k);
    H.push({ date: k, cm: v }); H.sort((a, b) => a.date.localeCompare(b.date));
    state.tests.heights = H; ui.heightIn = "";
  },
  editSetup() { ui.screen = "onb"; ui.step = 1; ui.editing = true; scrollTo(0, 0); },
  privacy() { ui.sheet = { kind: "privacy" }; },
  openReminders() { ui.sheet = { kind: "reminders" }; },
  resetReminders() { state.reminders = defaultReminders(); },
  resetAsk() { ui.sheet = { kind: "reset" }; },
  resetDo() { const lang = state.lang; state = defaultState(); state.lang = lang; save(); ui.sheet = null; ui.screen = "welcome"; },
  closeSheet() { ui.sheet = null; ui.error = ""; },
  bgClose(el, e) { if (e.target === el) { ui.sheet = null; ui.error = ""; } }
};

// One listener for every click in the app ("event delegation")
document.addEventListener("click", e => {
  const el = e.target.closest("[data-a]");
  if (!el || el.tagName === "INPUT") return;
  const fn = actions[el.dataset.a]; if (!fn) return;
  if (el.dataset.a === "bgClose" && e.target !== el) return;
  e.preventDefault();
  const r = fn(el, e);
  save();
  if (!(r instanceof Promise)) render();
});
// Typing: store the value without redrawing (so the keyboard stays open)
document.addEventListener("input", e => {
  const el = e.target; if (!el.dataset.f || el.type === "checkbox" || el.tagName === "SELECT") return;
  setPath(el.dataset.f, el.dataset.t === "num" && el.value !== "" ? Number(el.value) : el.value);
  save();
  if (el.dataset.f.startsWith("jump.")) { // update "best" live
    const best = Math.max(0, ...ui.jump.map(Number).filter(Boolean));
    const out = [...document.querySelectorAll(".card .row.between span")].find(s => s.style.fontSize === "32px"); if (out) out.textContent = best || "—";
  }
});
// Selects, checkboxes, dates and files: store and redraw
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.a === "file") { const f = el.files?.[0]; state.setup.sc.fileName = f ? f.name : ""; save(); render(); return; }
  if (!el.dataset.f) return;
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (el.type === "checkbox" && el.dataset.t === "invert") v = !v;
  else if (el.dataset.t === "num" && v !== "") v = Number(v);
  setPath(el.dataset.f, v); save();
  if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "date" || el.dataset.f === "setup.profile.dob") render();
});
// Android: remember the "install app" offer
addEventListener("beforeinstallprompt", e => { e.preventDefault(); ui.installEvt = e; if (ui.screen === "notify") render(); });

// ---------- 16. CALENDAR EXPORT (.ics) ----------
// Creates a calendar file with alarms. The phone's own calendar then sends the reminders.
// Reminder rules:
//  - "before": X minutes before the start (e.g. games 3 h before = time to eat).
//  - "evening before": one reminder at e.g. 20:00 listing tomorrow's plan,
//    attached only to the first item of tomorrow that asks for it.
//  - Grouping: sessions starting within 60 min of an earlier reminded one share its reminder.
//  - Quiet hours (22:00–07:00): a reminder that would fall before 07:00 moves to 07:00.
function remindersFor(items) {
  const label = i => `${i.start} ${i.type === "game" ? t("types").game + " " : ""}${itemTitle(i)}`;
  const R = state.reminders, out = new Map(); // item.id -> [{ minutesBefore, text }]
  const add = (i, m, text) => { if (!out.has(i.id)) out.set(i.id, []); out.get(i.id).push({ m, text }); };
  // evening before
  const eveItems = items.filter(i => (R[i.type] || R.other).eve);
  if (eveItems.length) {
    const first = eveItems[0];
    const minutes = toMin(first.start) + (1440 - toMin(R.eveTime));
    const list = eveItems.map(label).join(", ");
    add(first, minutes, `${t("tomorrow")}: ${list}`);
  }
  // before start, with grouping and quiet hours
  let lastRemindedStart = -999;
  for (const i of items) {
    const before = (R[i.type] || R.other).before; if (!before) continue;
    const st = toMin(i.start);
    if (st - lastRemindedStart < 60 && i.type !== "game") continue; // grouped with the previous reminder
    let at = st - before;
    if (R.quiet && at < 7 * 60) { if (st <= 7 * 60) continue; at = 7 * 60; }
    const sameTime = items.filter(x => x !== i && toMin(x.start) >= st && toMin(x.start) - st < 60 && (R[x.type] || R.other).before && x.type !== "game");
    const text = [i, ...sameTime].map(label).join(" · ");
    add(i, st - at, text);
    lastRemindedStart = st;
  }
  return out;
}
function buildIcs() {
  const icsEsc = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const dt = (k, time) => k.replaceAll("-", "") + "T" + time.replace(":", "") + "00";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Athlete Planner//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${t("appName")}`];
  for (let k = todayKey(); k <= (state.endDate || seasonEnd(todayKey())); k = addDays(k, 1)) {
    const items = dayPlan(k).active, alarms = remindersFor(items);
    for (const i of items) {
      const endMin = toMin(i.start) + i.dur, endK = endMin >= 1440 ? addDays(k, 1) : k;
      const title = i.type === "game" ? `${t("types").game}: ${itemTitle(i)}` : itemTitle(i);
      lines.push("BEGIN:VEVENT", `UID:${i.id.replace("|", "-")}@athlete-planner`, `DTSTAMP:${stamp}`, `DTSTART:${dt(k, i.start)}`, `DTEND:${dt(endK, fromMin(endMin % 1440))}`, `SUMMARY:${icsEsc(title)}`);
      if (i.type === "game" && i.game.venue) lines.push(`LOCATION:${icsEsc(i.game.venue)}`);
      for (const a of alarms.get(i.id) || []) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(a.text)}`, `TRIGGER:-PT${a.m}M`, "END:VALARM");
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
function downloadIcs() {
  const blob = new Blob([buildIcs()], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "athlete-planner.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- DEMO DATA ----------
function seedDemo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const s = defaultState(), today = todayKey(), start = addDays(mondayOf(today), -42);
  s.lang = state.lang; s.onboarded = true; s.startDate = start; s.endDate = seasonEnd(today);
  Object.assign(s.setup.profile, { sport: "basketball", dob: "2011-05-14", gender: "m", years: 6, height: 172, fitness: 3, parentOk: true });
  s.setup.leagues = [{ source: "MKL", group: "U16 vaikinai", team: "Demo KM", name: "", url: "" }, { source: "RKL", group: "B divizionas, A grupė", team: "Demo KM", name: "", url: "" }];
  Object.assign(s.setup.rest, { seasonEnd: s.endDate });
  s.setup.sc.fileName = "S&C_planas.xlsx";
  const opp = ["Tornado KM", "Sostinės KM", "Nacionalinė KA", "Telšių SRC", "KA „Žalgiris“", "Alytaus KA", "Panevėžio SC", "Šiaulių KA „Saulė“"];
  let n = 0;
  for (let k = addDays(start, 2); k <= addDays(today, 120); k = addDays(k, n % 2 ? 4 : 3)) {
    s.games.push({ id: "g" + n, date: k, start: n % 2 ? "14:00" : "18:15", dur: 90, opponent: opp[n % opp.length], home: n % 2 === 0, venue: n % 2 === 0 ? "Namų salė" : "", league: n % 3 ? "MKL" : "RKL", status: "planned" });
    n++;
  }
  const prev = state; state = s;
  for (let k = start; k < today; k = addDays(k, 1)) {
    const lastWeek = k >= addDays(mondayOf(today), -7);
    for (const i of dayPlan(k).active) {
      const rpe = Math.min(10, Math.round((lastWeek ? 7.5 : 5) + rnd() * 2));
      s.log[i.id] = { rpe, minutes: i.type === "game" ? Math.round(12 + rnd() * 18) : null, pain: false, area: "", dur: i.dur, type: i.type, date: k };
    }
  }
  const lastGame = s.games.filter(g => g.date < today).pop(); if (lastGame) Object.assign(s.log[lastGame.id], { pain: true, area: "knee" });
  [224, 226, 225, 228, 227, 216].forEach((v, w) => s.tests.jumps.push({ date: addDays(start, 7 * w), vals: [v - 4, v, v - 2], best: v }));
  s.tests.heights = [{ date: addDays(today, -90), cm: 169.5 }, { date: addDays(today, -60), cm: 170.5 }, { date: addDays(today, -30), cm: 171.5 }];
  state = prev; return s;
}
if (DEMO && !state.onboarded) { state = seedDemo(); ui.screen = "main"; save(); }

// ---------- START ----------
render();
loadSchedules();
