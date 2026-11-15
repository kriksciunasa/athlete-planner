# Notes for reviewers

Thanks for taking a look! This is an **early test version (0.2)**, built in one day as a prototype to test with ~5 real athletes. Honest, critical feedback is very welcome.

## Try it
- **Live:** https://kriksciunasa.github.io/athlete-planner/
- **Demo with sample data:** https://kriksciunasa.github.io/athlete-planner/?demo (a full sample season with games, check-ins and test results, stored separately from real data)
- **Locally:** open `index.html` in a browser, or run `npx serve .` in this folder.
- Best viewed on a phone, or in the browser's mobile view (~390 px wide).

## What it is
A season planner for young athletes (first target: Lithuanian basketball leagues MKL and RKL):
- Onboarding builds a **yearly calendar** from rules: team practice days, rest days (fixed weekdays and/or around games), skills sessions, S&C days, season end.
- **Day / week / month / year** views; games can be postponed or cancelled and the plan **re-calculates around them**.
- **After-session check-in:** effort 1–10 (session RPE), minutes played, pain and body area.
- **Load screen with red flags:** weekly hours vs. age ("no more hours per week than your age", max 16), days off, load spike vs. 4-week average (acute:chronic ratio > 1.3), pain reports.
- **Tests:** weekly broad jump (drop ≥ 5% vs. recent average = fatigue warning), monthly height (growth spurt).
- **Reminders:** export to the phone calendar (.ics with VALARMs), with rule-based timing (evening before, X minutes before, grouping, quiet hours).
- UI in **Lithuanian** (main) and **English**.

## How it's built
| File | What it does |
|---|---|
| `index.html` | Loads everything. |
| `styles.css` | Look and feel (colours from the brand book). |
| `i18n.js` | All texts (LT/EN) and the MKL/RKL league lists. |
| `app.js` | All logic: state, plan engine, screens, actions, .ics export. |
| `manifest.webmanifest`, `icons/` | Home Screen install (PWA basics). |

- **No framework, no build step, no dependencies**, on purpose, so the owner (who is learning) can read everything.
- **Pattern:** a single `state` object, saved to `localStorage`, plus `render()`, which rebuilds the screen from `state` via template strings. One delegated click listener maps `data-a="actionName"` to `actions.actionName()`.
- **The plan engine (`dayPlan(date)`)** doesn't store sessions. It derives them from the rules + games + per-session overrides (`state.over`) + custom sessions. Moving a game therefore moves rest and light days automatically.
- **Data stays on the device.** No server, no accounts, no analytics.

## Known weak spots (we know, but tell us what matters most)
- **Rendering:** the whole screen re-renders via `innerHTML` on every action. That's fine at this size, but it's not how you'd build it long-term.
- **No automated tests yet.** It has been checked with a headless browser script and manual clicks only.
- **No service worker.** That means no offline mode and no push notifications yet.
- **Calendar export is a one-off file.** Re-importing on iPhone may **create duplicate events**. A subscribable calendar URL (webcal) needs a server, which is planned with Firebase.
- **Times are "floating" local times** in the .ics (no TZID). That's fine for Lithuania only.
- **Game schedules are entered by hand.** The plan is a nightly GitHub Actions scraper for RKL (plain HTML) and MKL (loaded dynamically, may need a headless browser).
- **The S&C file is only stored by name.** Parsing Excel is planned.
- **Load science:** ACWR is debated in the literature. It's used here as a gentle warning only, never as a diagnosis.
- **Under-18 consent** is a checkbox for now. GDPR-proper parental consent will come with accounts.

## Questions we'd love answers to
1. Is the "derive the plan from rules" approach sound, or would you store generated sessions?
2. What's the best next step for architecture: stay vanilla, or move to a small framework (Preact/Svelte)?
3. Push notifications for a PWA on iPhone: Firebase Cloud Messaging, or something simpler?
4. Anything that's confusing or broken on your phone?
