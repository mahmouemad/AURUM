/**
 * ================================================================
 *  AURUM ELITE FITNESS — script.js
 *  Author: Aurum Dev Team
 *
 *  Sections:
 *    0. Utilities & Storage Helpers
 *    1. State Management
 *    2. Header & Navigation
 *    3. BMR / TDEE Calculator (Mifflin-St Jeor)
 *    4. Macros Calculator (Evidence-Based Sports Nutrition)
 *    5. Dashboard Renderer
 *    6. Daily Checklist & Water Tracker
 *    7. Nutrition (Food) Log
 *    8. Workout Tracker (Progressive Overload + Epley 1RM)
 *    9. App Initialization
 * ================================================================
 */

'use strict';

/* ================================================================
   0. UTILITIES & STORAGE HELPERS
================================================================ */

/**
 * Rounds a number to a specified number of decimal places.
 * @param {number} n - The number to round.
 * @param {number} [dp=0] - Decimal places (default: 0).
 * @returns {number}
 */
const round = (n, dp = 0) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Saves a value to localStorage, serialized as JSON.
 * All keys are namespaced with 'aurum_' to avoid collisions.
 * @param {string} key
 * @param {*} value - Any JSON-serializable value.
 */
const save = (key, value) => {
  try {
    localStorage.setItem('aurum_' + key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
};

/**
 * Loads and parses a value from localStorage.
 * @param {string} key
 * @param {*} [fallback=null] - Default value if key is absent.
 * @returns {*} The parsed value, or the fallback.
 */
const load = (key, fallback = null) => {
  const raw = localStorage.getItem('aurum_' + key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); }
  catch (e) { return fallback; }
};

/**
 * Returns today's date as an ISO string "YYYY-MM-DD".
 * Used as the key for all per-day log data.
 * @returns {string}
 */
const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * Clamps a number between a min and max value.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

/**
 * Displays a short toast notification at the bottom of the screen.
 * @param {string} message
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * Query selector shorthand.
 * @param {string} sel - CSS selector
 * @returns {Element}
 */
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);


/* ================================================================
   1. STATE MANAGEMENT
   All mutable app state lives here and is kept in sync
   with localStorage on every mutation.
================================================================ */

const STATE = {
  /** User's saved nutrition targets. null until first calculation. */
  targets: load('targets', null),

  /**
   * Food log keyed by date string "YYYY-MM-DD".
   * Each entry: { id, name, cal, prot, fat, carb }
   */
  foodLog: load('foodLog', {}),

  /**
   * Workout log: flat array of all lift entries, newest first.
   * Each entry: { id, name, weight, sets, reps, rpe, notes, e1rm, isPR, ts }
   */
  workouts: load('workouts', []),

  /**
   * Daily checklist keyed by date string.
   * Each day: { centrum: bool, limitless: bool, creatine: bool }
   */
  checklist: load('checklist', {}),

  /**
   * Water intake keyed by date string.
   * Value: integer 0-8 (number of glasses consumed).
   */
  water: load('water', {}),
};


/* ================================================================
   2. HEADER & NAVIGATION
================================================================ */

/** Populates the header date display with the current day/date. */
function initHeader() {
  const now = new Date();
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const str = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
  document.getElementById('js-date').textContent = str;

  // Also update the dashboard date eyebrow
  const dashLabel = document.getElementById('dash-date-label');
  if (dashLabel) dashLabel.textContent = str;
}

/** Initializes bottom navigation tab switching. */
function initNav() {
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;

      // Update nav active state
      $$('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Show the correct page
      $$('.tab-page').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');

      // Re-render data-dependent tabs when visited
      if (tab === 'dashboard') renderDashboard();
      if (tab === 'nutrition') renderFoodLog();
      if (tab === 'workout')   renderWorkoutLog();
    });
  });
}

/**
 * Generic pill/toggle group handler.
 * Selects one pill at a time within a given group element.
 * @param {string} groupId - The ID of the container element.
 * @returns {{ getVal: () => string|null }} - Object with a getter for the active value.
 */
function initPillGroup(groupId) {
  const group = document.getElementById(groupId);
  group.addEventListener('click', e => {
    const target = e.target.closest('[data-val]');
    if (!target) return;
    group.querySelectorAll('[data-val]').forEach(el => el.classList.remove('active'));
    target.classList.add('active');
  });
  return {
    getVal: () => group.querySelector('.active')?.dataset.val ?? null,
  };
}


/* ================================================================
   3. BMR & TDEE CALCULATOR
================================================================ */

/**
 * Calculates Basal Metabolic Rate using the Mifflin-St Jeor Equation (1990).
 *
 * This is the most clinically validated BMR formula for the general population,
 * more accurate than the older Harris-Benedict (1919) equation.
 *
 * Equations:
 *   Men:   BMR = (10 × weight_kg) + (6.25 × height_cm) − (5 × age_yrs) + 5
 *   Women: BMR = (10 × weight_kg) + (6.25 × height_cm) − (5 × age_yrs) − 161
 *
 * Source: Mifflin MD, St Jeor ST, et al. Am J Clin Nutr. 1990;51(2):241-247.
 *
 * @param {number} weightKg  - Body weight in kilograms.
 * @param {number} heightCm  - Height in centimeters.
 * @param {number} ageYrs    - Age in years.
 * @param {string} sex       - 'male' or 'female'.
 * @returns {number} BMR in kcal/day.
 */
function calcBMR(weightKg, heightCm, ageYrs, sex) {
  const base = (10 * weightKg) + (6.25 * heightCm) - (5 * ageYrs);
  return sex === 'male' ? base + 5 : base - 161;
}

/**
 * Calculates Total Daily Energy Expenditure (TDEE).
 *
 * TDEE = BMR × Physical Activity Level (PAL) multiplier.
 *
 * Activity multipliers (revised Katch-McArdle / Harris-Benedict):
 *   1.200 — Sedentary:  little or no exercise, desk job
 *   1.375 — Light:      light exercise 1-3 days/week
 *   1.550 — Moderate:   moderate exercise 3-5 days/week
 *   1.725 — Active:     heavy exercise 6-7 days/week
 *   1.900 — Athletic:   very heavy exercise, physical job, or 2× training daily
 *
 * @param {number} bmr       - Basal Metabolic Rate in kcal/day.
 * @param {number} multiplier - Activity level multiplier.
 * @returns {number} TDEE in kcal/day.
 */
function calcTDEE(bmr, multiplier) {
  return bmr * multiplier;
}

/**
 * Calculates the adjusted daily calorie target based on the user's goal.
 *
 * Bulk   (+250 kcal surplus): Chosen over the commonly cited +500 to promote
 *         lean muscle gain while minimizing fat accrual. Research suggests
 *         ~0.25 kg/week lean gain is optimal; excess surplus stores as fat.
 *         Source: Slater & Phillips, J Sports Sci. 2011.
 *
 * Maintain (TDEE exactly): Energy balance — no surplus or deficit.
 *
 * Cut    (−500 kcal deficit): Creates a theoretical 0.45 kg/week fat loss.
 *         Based on the rule that 1 kg of body fat ≈ 7,700 kcal.
 *         500 kcal × 7 days = 3,500 kcal ÷ 7,700 ≈ 0.45 kg/week.
 *         This rate is aggressive yet sustainable and preserves muscle mass
 *         when protein intake is adequate.
 *         Source: Hall KD, et al. Am J Clin Nutr. 2012.
 *
 * @param {number} tdee
 * @param {string} goal - 'bulk' | 'maintain' | 'cut'
 * @returns {number} Adjusted calorie target in kcal/day.
 */
function calcCalorieTarget(tdee, goal) {
  const adjustments = { bulk: +250, maintain: 0, cut: -500 };
  return round(tdee + (adjustments[goal] ?? 0));
}


/* ================================================================
   4. MACROS CALCULATOR
================================================================ */

/**
 * Calculates optimal daily macronutrient targets in grams.
 *
 * ── PROTEIN ──
 *   Range: 1.6 – 2.2 g per kg of body weight.
 *   - Bulking:     2.0 g/kg — maximizes muscle protein synthesis (MPS) during
 *                  a surplus. (Morton RW, et al. Br J Sports Med. 2018)
 *   - Cutting:     2.2 g/kg — higher intake preserves lean mass during a
 *                  caloric deficit. (Helms ER, et al. Int J Sport Nutr. 2014)
 *   - Maintenance: 1.8 g/kg — adequate for active individuals maintaining mass.
 *   Caloric density: 4 kcal per gram of protein.
 *
 * ── FAT ──
 *   Target: 25% of total daily calories.
 *   This satisfies the recommended 20-35% range (AMDR) while remaining practical.
 *   Fat is essential for hormonal health (including testosterone synthesis),
 *   fat-soluble vitamin absorption (A, D, E, K), and cell membrane integrity.
 *   Never drop below 20% (0.6 g/kg min) — below that, hormones suffer.
 *   Caloric density: 9 kcal per gram of fat.
 *
 * ── CARBOHYDRATES ──
 *   Calculated as the REMAINING calories after protein and fat are allocated.
 *   This is the "fill the rest" approach, a widely used method in sport nutrition
 *   that prioritizes protein and fat first (both have specific physiological floors),
 *   and gives carbohydrates the remainder, which is appropriate since carbs are
 *   the most flexible macronutrient with the widest optimal range.
 *   Caloric density: 4 kcal per gram of carbohydrates.
 *
 * @param {number} targetCalories - Daily calorie target.
 * @param {number} weightKg       - Body weight in kilograms.
 * @param {string} goal           - 'bulk' | 'cut' | 'maintain'
 * @returns {{ protein: number, fat: number, carbs: number, proteinRatio: number }}
 */
function calcMacros(targetCalories, weightKg, goal) {
  // ── 1. Protein ──
  // Select the g/kg ratio based on the training goal
  const proteinRatioMap = { bulk: 2.0, cut: 2.2, maintain: 1.8 };
  const proteinRatio = proteinRatioMap[goal] ?? 1.8;
  const protein = round(weightKg * proteinRatio);        // grams
  const proteinKcal = protein * 4;                       // kcal from protein

  // ── 2. Fat ──
  // 25% of total target calories allocated to fat
  const fatKcal = round(targetCalories * 0.25);
  const fat = round(fatKcal / 9);                        // grams (9 kcal/g)

  // ── 3. Carbohydrates ──
  // Residual calories after protein and fat are satisfied
  const carbKcal = targetCalories - proteinKcal - fatKcal;
  const carbs = Math.max(0, round(carbKcal / 4));        // grams (4 kcal/g), floored at 0

  return { protein, fat, carbs, proteinRatio };
}


/* ================================================================
   CALCULATOR UI — Wiring inputs to the formulas
================================================================ */

let activityGroup, goalGroup; // Pill group controllers (set in init)

/** Handles the "Calculate" button click: reads inputs, runs math, renders output. */
function handleCalculate() {
  // ── Read and validate inputs ──
  const age    = parseFloat($('#inp-age').value);
  const weight = parseFloat($('#inp-weight').value);
  const height = parseFloat($('#inp-height').value);
  const sex    = $('#inp-sex').value;
  const actStr = activityGroup.getVal();
  const goal   = goalGroup.getVal();

  if (!age || !weight || !height) { showToast('Please fill all fields'); return; }
  if (isNaN(parseFloat(actStr)))  { showToast('Select activity level');  return; }
  if (!goal)                      { showToast('Select a goal');          return; }
  if (age < 13 || age > 99)       { showToast('Age must be 13–99');      return; }
  if (weight < 30 || weight > 300){ showToast('Weight: 30–300 kg');      return; }
  if (height < 100 || height > 250){ showToast('Height: 100–250 cm');    return; }

  const actMultiplier = parseFloat(actStr);

  // ── Run the science ──
  const bmr    = round(calcBMR(weight, height, age, sex));
  const tdee   = round(calcTDEE(bmr, actMultiplier));
  const target = calcCalorieTarget(tdee, goal);
  const macros = calcMacros(target, weight, goal);

  // ── Populate results ──
  document.getElementById('res-bmr').textContent    = bmr.toLocaleString();
  document.getElementById('res-tdee').textContent   = tdee.toLocaleString();
  document.getElementById('res-target').textContent = target.toLocaleString();

  // Goal badge
  const badge = document.getElementById('result-goal-badge');
  const badgeLabels = {
    bulk:     '↑ Bulking +250 kcal',
    maintain: '— Maintenance',
    cut:      '↓ Cutting −500 kcal',
  };
  badge.textContent = badgeLabels[goal] ?? goal;
  badge.className   = `goal-badge ${goal}`;

  // Macro bars: calculate percentage of each macro relative to total calories
  const totalKcal = (macros.protein * 4) + (macros.fat * 9) + (macros.carbs * 4);
  const protPct = clamp(round((macros.protein * 4 / totalKcal) * 100), 0, 100);
  const fatPct  = clamp(round((macros.fat * 9   / totalKcal) * 100), 0, 100);
  const carbPct = clamp(round((macros.carbs * 4  / totalKcal) * 100), 0, 100);

  // Animate bars in after a short delay
  setTimeout(() => {
    document.getElementById('bar-protein').style.width = protPct + '%';
    document.getElementById('bar-fat').style.width     = fatPct  + '%';
    document.getElementById('bar-carbs').style.width   = carbPct + '%';
  }, 80);

  document.getElementById('val-protein').textContent = `${macros.protein}g · ${macros.proteinRatio}g/kg`;
  document.getElementById('val-fat').textContent     = `${macros.fat}g · 25%`;
  document.getElementById('val-carbs').textContent   = `${macros.carbs}g · residual`;

  document.getElementById('macro-formula-note').textContent =
    `Mifflin-St Jeor (1990) · Activity ×${actMultiplier} · `
  + `Protein ${macros.proteinRatio}g/kg body weight · Fat = 25% of kcal · Carbs = remainder`;

  // Show the results panel
  const panel = document.getElementById('results-panel');
  panel.style.display = 'block';
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  // Cache result for the Save button
  window._pendingTargets = { calories: target, protein: macros.protein, fat: macros.fat, carbs: macros.carbs, weight, goal };
}

/** Saves the last-calculated targets to STATE and localStorage. */
function handleSaveTargets() {
  if (!window._pendingTargets) { showToast('Calculate targets first'); return; }
  STATE.targets = window._pendingTargets;
  save('targets', STATE.targets);
  showToast('✦ Targets saved to Dashboard');
  // Auto-navigate to dashboard
  setTimeout(() => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    $('[data-tab="dashboard"]').classList.add('active');
    $$('.tab-page').forEach(p => p.classList.remove('active'));
    $('#tab-dashboard').classList.add('active');
    renderDashboard();
  }, 600);
}


/* ================================================================
   5. DASHBOARD RENDERER
================================================================ */

/**
 * Aggregates today's food log totals into a single object.
 * @returns {{ cal: number, prot: number, fat: number, carb: number }}
 */
function getTodayTotals() {
  const entries = STATE.foodLog[todayKey()] ?? [];
  return entries.reduce((acc, f) => ({
    cal:  acc.cal  + (f.cal  || 0),
    prot: acc.prot + (f.prot || 0),
    fat:  acc.fat  + (f.fat  || 0),
    carb: acc.carb + (f.carb || 0),
  }), { cal: 0, prot: 0, fat: 0, carb: 0 });
}

/**
 * Main dashboard render function.
 * Reads STATE.targets and today's food log to update all UI elements.
 */
function renderDashboard() {
  const targets = STATE.targets;
  const empty   = document.getElementById('dash-empty');
  const main    = document.getElementById('dash-main');

  if (!targets) {
    empty.style.display = 'block';
    main.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';
  main.style.display  = 'block';

  const totals = getTodayTotals();

  // ── Calorie Ring ──
  // SVG ring: r=66, circumference = 2π × 66 ≈ 414.69
  const CIRCUMFERENCE = 2 * Math.PI * 66; // ≈ 414.69
  const calProgress   = clamp(totals.cal / targets.calories, 0, 1);
  const dashOffset    = CIRCUMFERENCE * (1 - calProgress);
  const ring          = document.getElementById('ring-fill');
  ring.style.strokeDashoffset = round(dashOffset, 2);

  // Color feedback: gold < 90% · amber 90–100% · red > 100%
  if (calProgress > 1.0)       ring.style.stroke = '#c06060';
  else if (calProgress > 0.90) ring.style.stroke = '#c4895a';
  else                         ring.style.stroke = '#c9a84c';

  document.getElementById('ring-consumed').textContent  = Math.round(totals.cal).toLocaleString();
  document.getElementById('ring-of').textContent        = `of ${targets.calories.toLocaleString()} kcal`;
  const remaining = targets.calories - Math.round(totals.cal);
  document.getElementById('ring-remaining').textContent =
    remaining >= 0
      ? `${remaining.toLocaleString()} kcal remaining`
      : `${Math.abs(remaining).toLocaleString()} kcal over target`;

  // ── Protein Bar ──
  const protPct = clamp(round((totals.prot / targets.protein) * 100), 0, 100);
  document.getElementById('dash-prot-bar').style.width   = protPct + '%';
  document.getElementById('dash-prot-cur').textContent   = round(totals.prot, 1) + 'g';
  document.getElementById('dash-prot-tgt').textContent   = targets.protein + 'g';

  // ── Mini stats (Fat + Carbs) ──
  document.getElementById('dash-fat-cur').textContent  = round(totals.fat,  1) + 'g';
  document.getElementById('dash-fat-tgt').textContent  = '/ ' + targets.fat + 'g';
  document.getElementById('dash-carb-cur').textContent = round(totals.carb, 1) + 'g';
  document.getElementById('dash-carb-tgt').textContent = '/ ' + targets.carbs + 'g';

  // ── Checklist & Water ──
  renderChecklist();
  renderWaterCups();
}


/* ================================================================
   6. DAILY CHECKLIST & WATER TRACKER
================================================================ */

/**
 * Master list of daily supplement/habit checklist items.
 * Each object defines one item's display data.
 */
const CHECKLIST_DEFS = [
  {
    id:   'centrum',
    name: 'Centrum Multivitamin',
    dose: '1 tablet daily, with food',
    tag:  'Vitamins',
  },
  {
    id:   'limitless',
    name: 'Limitless Power Max',
    dose: '1 serving pre-workout, 20–30 min before',
    tag:  'Pre-Workout',
  },
  {
    id:   'creatine',
    name: 'Creatine Monohydrate',
    dose: '5g daily — timing is irrelevant, consistency matters',
    tag:  '5g / day',
  },
];

/**
 * Renders the checklist items into the DOM.
 * Each item reads its checked state from STATE.checklist[todayKey()].
 */
function renderChecklist() {
  const key     = todayKey();
  const dayData = STATE.checklist[key] ?? {};
  const container = document.getElementById('checklist-items');
  container.innerHTML = '';

  CHECKLIST_DEFS.forEach(def => {
    const isDone = !!dayData[def.id];
    const item = document.createElement('div');
    item.className  = 'checklist-item' + (isDone ? ' done' : '');
    item.innerHTML  = `
      <div class="check-box">${isDone ? '✓' : ''}</div>
      <div class="check-info">
        <div class="check-name">${def.name}</div>
        <div class="check-dose">${def.dose}</div>
      </div>
      <div class="check-tag">${def.tag}</div>
    `;
    item.addEventListener('click', () => toggleChecklistItem(def.id));
    container.appendChild(item);
  });
}

/**
 * Toggles a single checklist item's completion state.
 * @param {string} id - The item's identifier string.
 */
function toggleChecklistItem(id) {
  const key = todayKey();
  if (!STATE.checklist[key]) STATE.checklist[key] = {};
  STATE.checklist[key][id] = !STATE.checklist[key][id];
  save('checklist', STATE.checklist);
  renderChecklist();
}

/**
 * Renders 8 water cup elements based on today's intake count.
 * Tapping any cup fills up to that count; tapping the current count
 * decrements by 1, allowing correction.
 */
function renderWaterCups() {
  const key     = todayKey();
  const filled  = STATE.water[key] ?? 0;
  document.getElementById('water-num').textContent = filled;

  const container = document.getElementById('water-cups');
  container.innerHTML = '';

  for (let i = 0; i < 8; i++) {
    const cup = document.createElement('div');
    cup.className = 'water-cup' + (i < filled ? ' filled' : '');
    cup.innerHTML = `<div class="water-cup-fill"></div>`;

    // Clicking cup i+1 fills to i+1; clicking the last filled cup unfills it
    const cupIndex = i + 1;
    cup.addEventListener('click', () => {
      const current = STATE.water[todayKey()] ?? 0;
      STATE.water[todayKey()] = (current === cupIndex) ? cupIndex - 1 : cupIndex;
      save('water', STATE.water);
      renderWaterCups();
      if (STATE.water[todayKey()] >= 8) showToast('✦ Hydration goal complete!');
    });

    container.appendChild(cup);
  }
}

/** Resets today's water count to 0. */
function resetWater() {
  STATE.water[todayKey()] = 0;
  save('water', STATE.water);
  renderWaterCups();
}


/* ================================================================
   7. NUTRITION LOG
================================================================ */

/** Handles "Add to Log" button click for the food tracker. */
function handleAddFood() {
  const name = $('#food-name').value.trim();
  const cal  = parseFloat($('#food-cal').value)  || 0;
  const prot = parseFloat($('#food-prot').value) || 0;
  const fat  = parseFloat($('#food-fat').value)  || 0;
  const carb = parseFloat($('#food-carb').value) || 0;

  if (!name)  { showToast('Enter a food name'); return; }
  if (cal < 0){ showToast('Calories cannot be negative'); return; }

  const key = todayKey();
  if (!STATE.foodLog[key]) STATE.foodLog[key] = [];

  const entry = { id: Date.now(), name, cal, prot, fat, carb };
  STATE.foodLog[key].push(entry);
  save('foodLog', STATE.foodLog);

  // Clear inputs
  ['food-name','food-cal','food-prot','food-fat','food-carb'].forEach(id => {
    document.getElementById(id).value = '';
  });

  renderFoodLog();
  // Keep dashboard ring synced if it's showing
  renderDashboard();
  showToast('Meal logged');
}

/**
 * Removes a food entry by its ID from today's log.
 * @param {number} id - The timestamp-based unique ID.
 */
function removeFoodEntry(id) {
  const key = todayKey();
  STATE.foodLog[key] = (STATE.foodLog[key] ?? []).filter(f => f.id !== id);
  save('foodLog', STATE.foodLog);
  renderFoodLog();
  renderDashboard();
}

/**
 * Renders today's food log entries and the running totals row.
 */
function renderFoodLog() {
  const key     = todayKey();
  const entries = STATE.foodLog[key] ?? [];
  const list    = document.getElementById('food-list');
  const empty   = document.getElementById('food-empty');
  const totals  = document.getElementById('food-totals');

  if (entries.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    totals.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = '';

  let sumCal = 0, sumProt = 0, sumFat = 0, sumCarb = 0;

  entries.forEach(f => {
    sumCal  += f.cal;
    sumProt += f.prot;
    sumFat  += f.fat;
    sumCarb += f.carb;

    const el = document.createElement('div');
    el.className = 'food-entry';
    el.innerHTML = `
      <div class="food-entry-left">
        <div class="food-entry-name">${f.name}</div>
        <div class="food-entry-macros">P ${round(f.prot,1)}g · F ${round(f.fat,1)}g · C ${round(f.carb,1)}g</div>
      </div>
      <div class="food-entry-right">
        <div class="food-entry-cal">${Math.round(f.cal)} kcal</div>
        <button class="del-btn" title="Remove" onclick="removeFoodEntry(${f.id})">✕</button>
      </div>
    `;
    list.appendChild(el);
  });

  // Totals
  totals.style.display = 'grid';
  document.getElementById('tot-cal').textContent  = Math.round(sumCal).toLocaleString();
  document.getElementById('tot-prot').textContent = round(sumProt, 1) + 'g';
  document.getElementById('tot-fat').textContent  = round(sumFat,  1) + 'g';
  document.getElementById('tot-carb').textContent = round(sumCarb, 1) + 'g';
}


/* ================================================================
   8. WORKOUT TRACKER
================================================================ */

/**
 * Estimates One-Rep Max (1RM) using the Epley Formula (1985).
 *
 *   Epley:  1RM = weight × (1 + reps / 30)
 *
 * This is the most widely used 1RM estimation formula in strength
 * sports. It is valid for sets of ≤ 10 reps; above 10 reps accuracy
 * degrades but it remains a useful relative benchmark.
 *
 * Source: Epley, Boyd. "Poundage Chart." NSCA Journal, vol. 7, no. 6, 1985, p. 65.
 *
 * @param {number} weight - Weight lifted in kg.
 * @param {number} reps   - Number of repetitions performed.
 * @returns {number} Estimated 1RM in kg.
 */
function calcEpley1RM(weight, reps) {
  if (reps === 1) return weight; // Actual 1RM, no formula needed
  return weight * (1 + reps / 30);
}

/** Handles "Log This Lift" button click. */
function handleAddWorkout() {
  const name   = $('#ex-name').value.trim();
  const weight = parseFloat($('#ex-weight').value);
  const sets   = parseInt($('#ex-sets').value);
  const reps   = parseInt($('#ex-reps').value);
  const rpe    = parseFloat($('#ex-rpe').value) || null;
  const notes  = $('#ex-notes').value.trim();

  if (!name)              { showToast('Enter exercise name'); return; }
  if (isNaN(weight))      { showToast('Enter weight');        return; }
  if (!sets || sets < 1)  { showToast('Enter valid sets');    return; }
  if (!reps || reps < 1)  { showToast('Enter valid reps');    return; }

  // ── Calculate estimated 1RM ──
  const e1rm = round(calcEpley1RM(weight, reps), 1);

  // ── Check for Personal Record ──
  // Compare this e1RM against all previous entries for the same exercise
  const nameLower  = name.toLowerCase();
  const prevBestE1rm = STATE.workouts
    .filter(w => w.name.toLowerCase() === nameLower)
    .reduce((best, w) => Math.max(best, w.e1rm ?? 0), 0);

  const isPR = e1rm > prevBestE1rm;

  const entry = {
    id: Date.now(),
    name, weight, sets, reps,
    rpe: rpe,
    notes,
    e1rm,
    isPR,
    ts: new Date().toISOString(),
  };

  STATE.workouts.unshift(entry); // newest first
  save('workouts', STATE.workouts);

  // Clear form
  ['ex-name','ex-weight','ex-sets','ex-reps','ex-rpe','ex-notes']
    .forEach(id => document.getElementById(id).value = '');

  renderWorkoutLog();
  showToast(isPR ? '🔥 New Personal Record!' : 'Lift logged');
}

/**
 * Removes a single workout entry by its ID.
 * @param {number} id
 */
function removeWorkoutEntry(id) {
  STATE.workouts = STATE.workouts.filter(w => w.id !== id);
  save('workouts', STATE.workouts);
  renderWorkoutLog();
}

/** Clears the entire workout history after soft confirmation. */
function clearWorkoutHistory() {
  if (!STATE.workouts.length) { showToast('History is already empty'); return; }
  STATE.workouts = [];
  save('workouts', STATE.workouts);
  renderWorkoutLog();
  showToast('History cleared');
}

/**
 * Renders the full workout history into the DOM.
 * Shows exercise name, weight, sets, reps, estimated 1RM,
 * PR badge if applicable, and optional notes.
 */
function renderWorkoutLog() {
  const list  = document.getElementById('workout-list');
  const empty = document.getElementById('workout-empty');

  if (!STATE.workouts.length) {
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = '';

  STATE.workouts.forEach(w => {
    const dateStr = new Date(w.ts).toLocaleDateString('en-US', {
      month: 'short', day: '2-digit', year: 'numeric',
    });
    const timeStr = new Date(w.ts).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
    });

    const prHTML    = w.isPR ? `<div class="pr-badge">✦ Personal Record</div>` : '';
    const rpeHTML   = w.rpe  ? `<div class="workout-chip"><div class="workout-chip-val">${w.rpe}</div><div class="workout-chip-key">RPE</div></div>` : '';
    const notesHTML = w.notes ? `<div class="workout-notes">${w.notes}</div>` : '';

    const el = document.createElement('div');
    el.className = 'workout-entry';
    el.innerHTML = `
      <div class="workout-entry-header">
        <div class="workout-name">${w.name}</div>
        <div class="workout-date">${dateStr}<br/>${timeStr}</div>
      </div>
      <div class="workout-stats-row">
        <div class="workout-chip">
          <div class="workout-chip-val">${w.weight}<span style="font-size:10px">kg</span></div>
          <div class="workout-chip-key">Weight</div>
        </div>
        <div class="workout-chip">
          <div class="workout-chip-val">${w.sets}</div>
          <div class="workout-chip-key">Sets</div>
        </div>
        <div class="workout-chip">
          <div class="workout-chip-val">${w.reps}</div>
          <div class="workout-chip-key">Reps</div>
        </div>
        ${rpeHTML}
        <div class="workout-chip gold">
          <div class="workout-chip-val">~${w.e1rm}<span style="font-size:10px">kg</span></div>
          <div class="workout-chip-key">est. 1RM</div>
        </div>
      </div>
      ${prHTML}
      ${notesHTML}
      <div style="text-align:right; margin-top:8px;">
        <button class="ghost-btn danger" onclick="removeWorkoutEntry(${w.id})">Remove</button>
      </div>
    `;
    list.appendChild(el);
  });
}


/* ================================================================
   9. APP INITIALIZATION
================================================================ */

/** Bootstraps the entire application once the DOM is ready. */
function init() {
  // ── Header & Nav ──
  initHeader();
  initNav();

  // ── Pill groups ──
  activityGroup = initPillGroup('activity-group');
  goalGroup     = initPillGroup('goal-group');

  // ── Calculator buttons ──
  $('#btn-calculate').addEventListener('click', handleCalculate);
  $('#btn-save-targets').addEventListener('click', handleSaveTargets);

  // ── Dashboard water reset ──
  document.getElementById('water-reset').addEventListener('click', resetWater);

  // ── Nutrition buttons ──
  $('#btn-add-food').addEventListener('click', handleAddFood);
  // Allow Enter key in food-name field to submit
  $('#food-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddFood();
  });

  // ── Workout buttons ──
  $('#btn-add-workout').addEventListener('click', handleAddWorkout);
  $('#btn-clear-lifts').addEventListener('click', clearWorkoutHistory);
  // Allow Enter in exercise name field
  $('#ex-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddWorkout();
  });

  // ── Initial render ──
  renderDashboard();  // Render dashboard on load (shows empty state or real data)
  renderFoodLog();    // Pre-populate food list in case user lands on that tab
  renderWorkoutLog(); // Pre-populate workout list

  // ── Animate in ──
  document.querySelector('.app-shell').style.opacity = '0';
  requestAnimationFrame(() => {
    document.querySelector('.app-shell').style.transition = 'opacity 0.5s ease';
    document.querySelector('.app-shell').style.opacity = '1';
  });

  console.log(
    '%c AURUM FITNESS OS · Initialized ',
    'background:#c9a84c; color:#0a0908; font-weight:700; font-size:13px; padding:6px 14px; border-radius:4px;'
  );
}

// Run init after DOM is fully parsed
document.addEventListener('DOMContentLoaded', init);
// تشغيل الـ Service Worker عشان الموبايل يتعرف عليه كتطبيق
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('AURUM App is ready for install!'))
      .catch(err => console.log('SW Error: ', err));
  });
}