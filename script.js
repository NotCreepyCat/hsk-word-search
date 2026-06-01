/* ============================================================
   HSK Word Search — script.js
   Vanilla JS, no dependencies
   ============================================================ */

// ============================================================
// Config
// ============================================================

const GRID_SIZES = {
  easy:   { rows: 8,  cols: 8  },
  medium: { rows: 12, cols: 12 },
  hard:   { rows: 16, cols: 16 },
};

// Keys for localStorage
const STORAGE_STATS    = 'hsk-wordsearch-stats';
const STORAGE_SETTINGS = 'hsk-wordsearch-settings';

// ============================================================
// State
// ============================================================

const state = {
  // --- Settings (persisted) ---
  level:           'mixed',   // '1'..'6' | '7-9' | 'mixed'
  difficulty:      'easy',
  filterMode:      'all',     // 'all' | 'single' | 'multi'
  showPinyin:      true,
  showTranslation: true,
  timerMode:       false,
  darkMode:        false,
  gameMode:        'search',  // 'search' | 'pair'

  // --- Term pools ---
  terms:       [],  // filtered terms for current settings
  charEntries: [],  // { char, term } entries from ALL HSK data (for grid filler)

  // --- Current round ---
  target:    null,  // { simplified, pinyin, english, level, label }
  placement: null,  // { row, col, length }  — always horizontal

  // --- Pair mode round state ---
  pairState: {
    char:          null,  // the character that appears twice
    term:          null,  // associated term for tooltip/card
    cells:         [],    // [{row, col}, {row, col}]
    firstSelected: null,  // {row, col} of first clicked pair cell, or null
  },

  grid:      [],    // 2D array: grid[row][col] = char string

  // --- Statistics (persisted) ---
  stats: {
    correct:    0,
    total:      0,
    streak:     0,
    bestStreak: 0,
  },

  // --- Timer ---
  timerSeconds:  0,
  timerInterval: null,
};

// ============================================================
// Data — build term / character pools from window.HSK_DATA
// ============================================================

/**
 * Rebuild state.terms and state.charPool based on current settings.
 * Call this after changing level or filterMode.
 */
function buildPool() {
  const allLevels = window.HSK_DATA || [];

  // --- Collect terms for chosen level(s) ---
  let terms = [];

  if (state.level === 'mixed') {
    allLevels.forEach(lvl => {
      const label = lvl.label || `HSK ${lvl.level}`;
      lvl.terms.forEach(t => terms.push({ ...t, level: lvl.level, label }));
    });
  } else {
    const found = allLevels.find(
      lvl => String(lvl.level) === state.level
          || lvl.label === `HSK ${state.level}`
    );
    if (found) {
      const label = found.label || `HSK ${found.level}`;
      terms = found.terms.map(t => ({ ...t, level: found.level, label }));
    }
  }

  // Apply word-length filter
  if (state.filterMode === 'single') {
    terms = terms.filter(t => t.simplified.length === 1);
  } else if (state.filterMode === 'multi') {
    terms = terms.filter(t => t.simplified.length > 1);
  }

  state.terms = terms;

  // --- Build filler entries from levels 1..selected (cumulative) ---
  // "mixed" → all levels; specific level N → levels 1 through N.
  // This way HSK 2 filler contains HSK 1 + HSK 2 characters, etc.
  const selectedRank = levelRank(state.level);
  const fillerLevels = state.level === 'mixed'
    ? allLevels
    : allLevels.filter(lvl => levelRank(String(lvl.level)) <= selectedRank);

  const charEntries = [];
  fillerLevels.forEach(lvl => {
    const lbl = lvl.label || `HSK ${lvl.level}`;
    lvl.terms.forEach(t => {
      for (const ch of t.simplified) {
        charEntries.push({
          char: ch,
          term: { simplified: t.simplified, pinyin: t.pinyin, english: t.english, label: lbl, level: lvl.level },
        });
      }
    });
  });
  state.charEntries = charEntries;
}

/**
 * Return a numeric rank for a level value so levels can be compared.
 * '1'→1, '2'→2, ..., '6'→6, '7-9'→7
 */
function levelRank(lvl) {
  if (!lvl || lvl === 'mixed') return Infinity;
  if (String(lvl).startsWith('7')) return 7;
  return parseInt(lvl, 10) || 99;
}

/** Pick a random { char, term } entry from the filler pool. */
function randomCharEntry() {
  if (state.charEntries.length === 0) return { char: '字', term: null };
  return state.charEntries[Math.floor(Math.random() * state.charEntries.length)];
}

// ============================================================
// Grid Generation
// ============================================================

/**
 * Generate a full grid for the given word.
 * Sets state.placement as a side-effect.
 *
 * @param {string} word - simplified Chinese word/character to place
 * @returns {string[][]} 2D grid array
 */
function generateGrid(word) {
  const { rows, cols } = GRID_SIZES[state.difficulty];
  const wordLen = word.length;

  // Clamp word length to fit; if word is too long for grid width,
  // the caller should have already filtered it out — but be safe.
  const effectiveCols = Math.max(cols, wordLen);

  // Initialize empty grid (null = unfilled)
  const grid = Array.from({ length: rows }, () => Array(effectiveCols).fill(null));

  // Place word horizontally at a random position
  const maxCol = effectiveCols - wordLen;
  const placedRow = Math.floor(Math.random() * rows);
  const placedCol = Math.floor(Math.random() * (maxCol + 1));

  // Each target cell stores its char + the full target term for the tooltip
  for (let i = 0; i < wordLen; i++) {
    grid[placedRow][placedCol + i] = { char: word[i], term: state.target };
  }

  // Save placement info
  state.placement = { row: placedRow, col: placedCol, length: wordLen };

  // Fill remaining cells with random {char, term} entries
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < effectiveCols; c++) {
      if (grid[r][c] === null) {
        grid[r][c] = randomCharEntry();
      }
    }
  }

  return grid;
}

/**
 * Generate a grid for "Find the Pair" mode.
 * Exactly two cells share the same character; every other cell is unique.
 * Sets state.pairState as a side-effect.
 *
 * @returns {Object[][]} 2D grid array of { char, term, isPair }
 */
function generatePairGrid() {
  const { rows, cols } = GRID_SIZES[state.difficulty];
  const totalCells = rows * cols;

  // Shuffle charEntries and collect unique-char entries
  const shuffled = [...state.charEntries].sort(() => Math.random() - 0.5);
  const seen = new Set();
  const uniqueEntries = [];
  for (const entry of shuffled) {
    if (!seen.has(entry.char)) {
      seen.add(entry.char);
      uniqueEntries.push(entry);
      if (uniqueEntries.length >= totalCells) break;
    }
  }

  // Ensure at least 2 entries exist
  while (uniqueEntries.length < 2) {
    uniqueEntries.push({ char: '字', term: null });
  }

  // The pair character (first in the shuffled unique list)
  const pairChar  = uniqueEntries[0].char;
  const pairTerm  = uniqueEntries[0].term;

  // Build flat cell list: two pair cells + (totalCells - 2) filler cells
  const flatCells = [
    { char: pairChar, term: pairTerm, isPair: true },
    { char: pairChar, term: pairTerm, isPair: true },
  ];
  for (let i = 1; i < totalCells - 1; i++) {
    if (i < uniqueEntries.length) {
      flatCells.push({ char: uniqueEntries[i].char, term: uniqueEntries[i].term, isPair: false });
    } else {
      const e = randomCharEntry();
      flatCells.push({ char: e.char, term: e.term, isPair: false });
    }
  }

  // Fisher-Yates shuffle
  for (let i = flatCells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [flatCells[i], flatCells[j]] = [flatCells[j], flatCells[i]];
  }

  // Build 2D grid and record pair positions
  const grid = [];
  const pairCells = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    grid.push([]);
    for (let c = 0; c < cols; c++) {
      const cell = flatCells[idx++];
      grid[r].push(cell);
      if (cell.isPair) pairCells.push({ row: r, col: c });
    }
  }

  state.pairState = {
    char:          pairChar,
    term:          pairTerm,
    cells:         pairCells,
    firstSelected: null,
  };

  return grid;
}

// ============================================================
// Game Flow
// ============================================================

/**
 * Start a new round: pick a target, generate the grid, render everything.
 */
function newRound() {
  stopTimer();

  if (state.gameMode === 'pair') {
    startPairRound();
    return;
  }

  if (state.terms.length === 0) {
    buildPool();
    if (state.terms.length === 0) {
      console.warn('No terms available for current settings.');
      return;
    }
  }

  // Pick a random target term
  const term = state.terms[Math.floor(Math.random() * state.terms.length)];
  state.target = term;

  // Generate the grid (sets state.placement)
  state.grid = generateGrid(term.simplified);

  // Render
  renderCard();
  renderGrid();
  renderStats();

  // Start timer if enabled
  if (state.timerMode) startTimer();
}

// ============================================================
// Click Handling
// ============================================================

/**
 * Handle a click on a grid cell at (row, col).
 * A click on ANY cell that belongs to the placed target word = correct.
 * A click anywhere else = wrong.
 */
function handleCellClick(row, col) {
  if (state.gameMode === 'pair') {
    handlePairCellClick(row, col);
    return;
  }

  const { placement } = state;
  if (!placement) return;

  const { row: pr, col: pc, length } = placement;

  // Check whether the clicked cell is part of the target word
  const isPartOfWord = (row === pr && col >= pc && col < pc + length);

  if (isPartOfWord) {
    handleCorrect();
  } else {
    handleWrong(row, col);
  }
}

/** Called when the player clicks a correct cell. */
function handleCorrect() {
  const { placement } = state;
  const { row: pr, col: pc, length } = placement;

  // Collect DOM elements for all target cells
  const cells = [];
  for (let i = 0; i < length; i++) {
    const el = getCellElement(pr, pc + i);
    if (el) cells.push(el);
  }

  // Run success animation (staggered)
  animateSuccess(cells);

  // Update stats
  state.stats.correct++;
  state.stats.total++;
  state.stats.streak++;
  if (state.stats.streak > state.stats.bestStreak) {
    state.stats.bestStreak = state.stats.streak;
  }
  saveStats();
  renderStats();
  stopTimer();

  // Start next round after a short pause
  setTimeout(() => newRound(), 1300);
}

/** Called when the player clicks a wrong cell. */
function handleWrong(row, col) {
  const el = getCellElement(row, col);
  if (!el) return;

  // Update accuracy stats (streak resets)
  state.stats.total++;
  state.stats.streak = 0;
  saveStats();
  renderStats();

  // Run shake animation
  animateWrong(el);
}

/** Return the DOM element for a grid cell at (row, col). */
function getCellElement(row, col) {
  return document.querySelector(`.grid-cell[data-row="${row}"][data-col="${col}"]`);
}

// ============================================================
// Pair Mode — round logic
// ============================================================

/** Start a new "Find the Pair" round. */
function startPairRound() {
  if (state.charEntries.length === 0) {
    buildPool();
  }

  state.grid = generatePairGrid();

  renderPairCard();
  renderGrid();
  renderStats();

  if (state.timerMode) startTimer();
}

/**
 * Handle a click on a grid cell in Pair mode.
 * The player must click both cells that share the same character.
 */
function handlePairCellClick(row, col) {
  const cell = state.grid[row][col];
  const { pairState } = state;

  if (!cell.isPair) {
    // Wrong cell — deselect first selection and shake
    if (pairState.firstSelected) {
      const { row: fr, col: fc } = pairState.firstSelected;
      const prevEl = getCellElement(fr, fc);
      if (prevEl) prevEl.classList.remove('cell-selected');
      pairState.firstSelected = null;
      renderPairCard();
    }
    handleWrong(row, col);
    return;
  }

  // Clicked a pair cell
  if (!pairState.firstSelected) {
    // First pair cell selected
    pairState.firstSelected = { row, col };
    const el = getCellElement(row, col);
    if (el) el.classList.add('cell-selected');
    renderPairCard();
  } else {
    const { row: fr, col: fc } = pairState.firstSelected;
    if (fr === row && fc === col) {
      // Clicked same cell again — deselect
      const el = getCellElement(row, col);
      if (el) el.classList.remove('cell-selected');
      pairState.firstSelected = null;
      renderPairCard();
      return;
    }
    // Second pair cell clicked — success!
    handlePairCorrect();
  }
}

/** Called when both pair cells are found. */
function handlePairCorrect() {
  const { pairState } = state;

  const cells = pairState.cells
    .map(({ row, col }) => getCellElement(row, col))
    .filter(Boolean);

  // Remove selected highlight before applying correct style
  cells.forEach(el => el.classList.remove('cell-selected'));
  animateSuccess(cells);

  state.stats.correct++;
  state.stats.total++;
  state.stats.streak++;
  if (state.stats.streak > state.stats.bestStreak) {
    state.stats.bestStreak = state.stats.streak;
  }
  saveStats();
  renderStats();
  stopTimer();

  setTimeout(() => newRound(), 1300);
}

/** Reveal both pair cells in amber (used when skipping in pair mode). */
function revealPairAnswer(onDone) {
  const { pairState } = state;
  if (!pairState || !pairState.cells.length) { onDone(); return; }

  // Deselect first selection if any
  if (pairState.firstSelected) {
    const { row, col } = pairState.firstSelected;
    const el = getCellElement(row, col);
    if (el) el.classList.remove('cell-selected');
    pairState.firstSelected = null;
  }

  const cells = pairState.cells
    .map(({ row, col }) => getCellElement(row, col))
    .filter(Boolean);

  cells.forEach((cell, i) => {
    setTimeout(() => cell.classList.add('cell-reveal'), i * 70);
  });

  const revealDuration = 900 + cells.length * 70;
  setTimeout(onDone, revealDuration);
}

/** Re-render the task card for Pair mode. */
function renderPairCard() {
  const card      = document.getElementById('task-card');
  const charEl    = document.getElementById('task-char');
  const pinyinEl  = document.getElementById('task-pinyin');
  const englishEl = document.getElementById('task-english');
  const levelEl   = document.getElementById('task-level');

  const { pairState } = state;

  if (pairState.firstSelected) {
    // One pair cell already clicked — reveal the character
    if (charEl)    charEl.textContent    = pairState.char || '?';
    if (levelEl)   levelEl.textContent   = pairState.term?.label || 'Find Pair';
    if (pinyinEl)  pinyinEl.textContent  = pairState.term?.pinyin  || '';
    if (englishEl) englishEl.textContent = pairState.term?.english || '';
    if (pinyinEl)  pinyinEl.style.display  = state.showPinyin      ? '' : 'none';
    if (englishEl) englishEl.style.display = state.showTranslation ? '' : 'none';
    if (card) {
      const lvl = String(pairState.term?.level || '1').replace(/[^0-9]/g, '');
      card.dataset.level = lvl.charAt(0) || '1';
    }
  } else {
    // No selection yet — show prompt
    if (charEl)    charEl.textContent    = '?';
    if (levelEl)   levelEl.textContent   = 'Find Pair';
    if (pinyinEl)  { pinyinEl.textContent = ''; pinyinEl.style.display = 'none'; }
    if (englishEl) { englishEl.textContent = 'Find two matching characters'; englishEl.style.display = ''; }
    if (card) {
      card.dataset.level = '';
      card.classList.remove('card-animate');
      void card.offsetWidth;
      card.classList.add('card-animate');
    }
  }
}



/** Highlight all target cells with a simultaneous success animation. */
function animateSuccess(cells) {
  cells.forEach(cell => cell.classList.add('cell-correct'));
}

/**
 * Highlight the target word's cells in amber (used when skipping),
 * then call onDone after the reveal duration.
 */
function revealAnswer(onDone) {
  if (state.gameMode === 'pair') {
    revealPairAnswer(onDone);
    return;
  }

  const { placement } = state;
  if (!placement) { onDone(); return; }

  const { row: pr, col: pc, length } = placement;
  const cells = [];
  for (let i = 0; i < length; i++) {
    const el = getCellElement(pr, pc + i);
    if (el) cells.push(el);
  }

  // Staggered amber highlight
  cells.forEach((cell, i) => {
    setTimeout(() => cell.classList.add('cell-reveal'), i * 70);
  });

  // Wait for the player to see the answer, then continue
  const revealDuration = 900 + cells.length * 70;
  setTimeout(onDone, revealDuration);
}

/** Flash and shake a wrong cell, then remove the class. */
function animateWrong(cell) {
  cell.classList.remove('cell-wrong'); // reset if already animating
  void cell.offsetWidth;              // force reflow to restart animation
  cell.classList.add('cell-wrong');
  setTimeout(() => cell.classList.remove('cell-wrong'), 600);
}

// ============================================================
// Rendering
// ============================================================

/** Re-render the task card on the left panel. */
function renderCard() {
  const { target } = state;
  if (!target) return;

  const card      = document.getElementById('task-card');
  const charEl    = document.getElementById('task-char');
  const pinyinEl  = document.getElementById('task-pinyin');
  const englishEl = document.getElementById('task-english');
  const levelEl   = document.getElementById('task-level');

  if (charEl)    charEl.textContent    = target.simplified;
  if (levelEl)   levelEl.textContent   = target.label || `HSK ${target.level}`;
  if (pinyinEl)  pinyinEl.textContent  = target.pinyin  || '';
  if (englishEl) englishEl.textContent = target.english || '';

  // Show / hide optional info
  if (pinyinEl)  pinyinEl.style.display  = state.showPinyin      ? '' : 'none';
  if (englishEl) englishEl.style.display = state.showTranslation ? '' : 'none';

  // Update level-based color theme on the card
  if (card) {
    // Normalize level: HSK 7-9 → "7"
    const lvl = String(target.level).replace(/-.*/, '');
    card.dataset.level = lvl;

    // Trigger entrance animation
    card.classList.remove('card-animate');
    void card.offsetWidth;
    card.classList.add('card-animate');
  }
}

/** Re-render the grid. */
function renderGrid() {
  const container = document.getElementById('grid-container');
  if (!container) return;

  const { grid } = state;
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;

  // Set CSS variable for grid column count
  container.style.setProperty('--grid-cols', cols);

  // Clear existing cells
  container.innerHTML = '';

  // Add entrance animation class
  container.classList.remove('grid-enter');
  void container.offsetWidth;
  container.classList.add('grid-enter');

  // Build cells
  const fragment = document.createDocumentFragment();
  const totalCells = rows * cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.textContent = grid[r][c].char;

      // Staggered entrance delay (capped so large grids aren't too slow)
      const index = r * cols + c;
      const maxDelay = 0.4;
      const delay = (index / totalCells) * maxDelay;
      cell.style.setProperty('--cell-delay', `${delay.toFixed(3)}s`);

      // Click handler
      cell.addEventListener('click', () => handleCellClick(r, c));

      // Tooltip: show word info on hover
      const termData = grid[r][c].term;
      if (termData) {
        cell.addEventListener('mouseenter', (e) => scheduleCellTooltip(e, termData));
        cell.addEventListener('mousemove',  moveCellTooltip);
        cell.addEventListener('mouseleave', hideCellTooltip);
      }

      fragment.appendChild(cell);
    }
  }

  container.appendChild(fragment);
}

/** Update the statistics display. */
function renderStats() {
  const { stats } = state;
  const accuracy = stats.total > 0
    ? Math.round((stats.correct / stats.total) * 100) + '%'
    : '—';

  const correctEl  = document.getElementById('stat-correct');
  const streakEl   = document.getElementById('stat-streak');
  const accuracyEl = document.getElementById('stat-accuracy');

  if (correctEl)  correctEl.textContent  = stats.correct;
  if (streakEl)   streakEl.textContent   = stats.streak;
  if (accuracyEl) accuracyEl.textContent = accuracy;
}

// ============================================================
// Timer
// ============================================================

function startTimer() {
  state.timerSeconds = 0;
  updateTimerDisplay();
  state.timerInterval = setInterval(() => {
    state.timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = document.getElementById('timer');
  if (!el) return;
  const s = state.timerSeconds;
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  el.textContent = `${mm}:${ss}`;
}

// ============================================================
// Persistence — Stats
// ============================================================

function loadStats() {
  try {
    const raw = localStorage.getItem(STORAGE_STATS);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge saved values into default state (safe against schema changes)
      Object.assign(state.stats, parsed);
    }
  } catch (e) {
    console.warn('Could not load stats from localStorage:', e);
  }
}

function saveStats() {
  try {
    localStorage.setItem(STORAGE_STATS, JSON.stringify(state.stats));
  } catch (e) {
    console.warn('Could not save stats to localStorage:', e);
  }
}

function resetStats() {
  state.stats = { correct: 0, total: 0, streak: 0, bestStreak: 0 };
  saveStats();
  renderStats();
}

// ============================================================
// Persistence — Settings
// ============================================================

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Restore each setting if present
    if (saved.level           !== undefined) state.level           = saved.level;
    if (saved.difficulty      !== undefined) state.difficulty      = saved.difficulty;
    if (saved.filterMode      !== undefined) state.filterMode      = saved.filterMode;
    if (saved.showPinyin      !== undefined) state.showPinyin      = saved.showPinyin;
    if (saved.showTranslation !== undefined) state.showTranslation = saved.showTranslation;
    if (saved.timerMode       !== undefined) state.timerMode       = saved.timerMode;
    if (saved.darkMode        !== undefined) state.darkMode        = saved.darkMode;
    if (saved.gameMode        !== undefined) state.gameMode        = saved.gameMode;
  } catch (e) {
    console.warn('Could not load settings from localStorage:', e);
  }
}

function saveSettings() {
  try {
    const toSave = {
      level:           state.level,
      difficulty:      state.difficulty,
      filterMode:      state.filterMode,
      showPinyin:      state.showPinyin,
      showTranslation: state.showTranslation,
      timerMode:       state.timerMode,
      darkMode:        state.darkMode,
      gameMode:        state.gameMode,
    };
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(toSave));
  } catch (e) {
    console.warn('Could not save settings to localStorage:', e);
  }
}

// ============================================================
// Settings UI — sync controls → state → rebuild + re-render
// ============================================================

/** Apply the current state to all UI controls (called once on init). */
function syncControlsToState() {
  // Level select
  const levelSelect = document.getElementById('setting-level');
  if (levelSelect) levelSelect.value = state.level;

  // Difficulty buttons
  document.querySelectorAll('.difficulty-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.difficulty === state.difficulty);
  });

  // Game Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.gameMode);
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === state.filterMode);
  });

  // Toggle checkboxes
  const pinyinToggle      = document.getElementById('toggle-pinyin');
  const translationToggle = document.getElementById('toggle-translation');
  const timerToggle       = document.getElementById('toggle-timer');

  if (pinyinToggle)      pinyinToggle.checked      = state.showPinyin;
  if (translationToggle) translationToggle.checked = state.showTranslation;
  if (timerToggle)       timerToggle.checked        = state.timerMode;

  // Dark mode
  applyDarkMode();

  // Game mode (sidebar data-mode + title)
  applyGameMode();

  // Timer visibility
  const timerEl = document.getElementById('timer');
  if (timerEl) timerEl.style.display = state.timerMode ? '' : 'none';
}

/** Apply or remove the dark theme class on <html>. */
function applyDarkMode() {
  document.documentElement.dataset.theme = state.darkMode ? 'dark' : '';
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.querySelector('.icon-moon').style.display = state.darkMode ? 'none' : '';
    btn.querySelector('.icon-sun').style.display  = state.darkMode ? ''     : 'none';
  }
}

/** Sync the sidebar data-mode attribute and title to current game mode. */
function applyGameMode() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.dataset.mode = state.gameMode;
  const titleEl = document.getElementById('app-title');
  if (titleEl) titleEl.textContent = state.gameMode === 'pair' ? 'Find Pair' : 'Word Search';
}

/** Attach all event listeners for the settings panel. */
function initSettingsListeners() {
  // --- HSK Level ---
  document.getElementById('setting-level')?.addEventListener('change', e => {
    state.level = e.target.value;
    buildPool();
    saveSettings();
    newRound();
  });

  // --- Difficulty ---
  document.querySelectorAll('.difficulty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.difficulty = btn.dataset.difficulty;
      saveSettings();
      newRound();
    });
  });

  // --- Word Filter ---
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filterMode = btn.dataset.filter;
      buildPool();
      saveSettings();
      newRound();
    });
  });

  // --- Show Pinyin ---
  document.getElementById('toggle-pinyin')?.addEventListener('change', e => {
    state.showPinyin = e.target.checked;
    saveSettings();
    if (state.gameMode === 'pair') renderPairCard(); else renderCard();
  });

  // --- Show Translation ---
  document.getElementById('toggle-translation')?.addEventListener('change', e => {
    state.showTranslation = e.target.checked;
    saveSettings();
    if (state.gameMode === 'pair') renderPairCard(); else renderCard();
  });

  // --- Game Mode ---
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.gameMode = btn.dataset.mode;
      applyGameMode();
      buildPool();
      saveSettings();
      newRound();
    });
  });

  // --- Timer Mode ---
  document.getElementById('toggle-timer')?.addEventListener('change', e => {
    state.timerMode = e.target.checked;
    const timerEl = document.getElementById('timer');
    if (timerEl) timerEl.style.display = state.timerMode ? '' : 'none';
    if (!state.timerMode) stopTimer();
    saveSettings();
  });

  // --- Dark Mode ---
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    applyDarkMode();
    saveSettings();
  });

  // --- Skip / Next ---
  document.getElementById('btn-next')?.addEventListener('click', () => {
    stopTimer();
    // Show where the answer was, then start a new round
    revealAnswer(() => newRound());
  });

  // --- Reset Stats ---
  document.getElementById('btn-reset-stats')?.addEventListener('click', () => {
    if (confirm('Reset all statistics?')) {
      resetStats();
    }
  });
}

// ============================================================
// Cell Tooltip
// ============================================================

let _tooltip = null;
let _tooltipTimer = null;

/** Cache the tooltip DOM element after the page loads. */
function initTooltip() {
  _tooltip = document.getElementById('cell-tooltip');
}

/** Show the tooltip near the cursor with word / pinyin / english. */
function showCellTooltip(event, term) {
  if (!term || !_tooltip) return;
  _tooltip.querySelector('.ct-word').textContent    = term.simplified;
  _tooltip.querySelector('.ct-pinyin').textContent  = term.pinyin  || '';
  _tooltip.querySelector('.ct-english').textContent = term.english || '';

  // Level badge: extract number from label ("HSK 2" → "2", "HSK 7-9" → "7-9")
  const badgeEl = _tooltip.querySelector('.ct-level-badge');
  if (badgeEl) {
    badgeEl.textContent = (term.label || '').replace(/^HSK\s*/i, '') || String(term.level || '');
  }

  // Color the border via data-level attribute
  const lvl = String(term.level || '').replace(/[^0-9]/g, '') || '1';
  _tooltip.dataset.level = lvl.charAt(0); // "7" covers "7-9"

  _tooltip.classList.remove('hidden');
  moveCellTooltip(event);
}

/** Schedule tooltip after a 1-second delay; cancel any pending timer first. */
function scheduleCellTooltip(event, term) {
  clearTimeout(_tooltipTimer);
  // Capture position at the moment of mouseenter
  const capturedEvent = { clientX: event.clientX, clientY: event.clientY };
  _tooltipTimer = setTimeout(() => showCellTooltip(capturedEvent, term), 1000);
}

/** Hide the tooltip and cancel any pending show timer. */
function hideCellTooltip() {
  clearTimeout(_tooltipTimer);
  _tooltipTimer = null;
  if (_tooltip) _tooltip.classList.add('hidden');
}

/** Reposition the tooltip to follow the cursor, clamped to viewport. */
function moveCellTooltip(event) {
  if (!_tooltip || _tooltip.classList.contains('hidden')) return;
  const x = event.clientX + 16;
  const y = event.clientY - 10;
  const w = _tooltip.offsetWidth;
  const h = _tooltip.offsetHeight;
  _tooltip.style.left = Math.min(x, window.innerWidth  - w - 8) + 'px';
  _tooltip.style.top  = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}

// ============================================================
// Dark mode: respect OS preference if no saved setting
// ============================================================

function detectSystemDarkMode() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (raw) return; // user has an explicit preference saved — skip
  } catch (e) { /* ignore */ }

  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    state.darkMode = true;
  }
}

// ============================================================
// Init
// ============================================================

function init() {
  // 0. Initialize UI components
  initTooltip();

  // 1. Detect system dark mode preference (before loading saved settings
  //    so saved settings can override it in loadSettings)
  detectSystemDarkMode();

  // 2. Restore saved settings & stats
  loadSettings();
  loadStats();

  // 3. Apply loaded state to UI controls
  syncControlsToState();

  // 4. Attach event listeners
  initSettingsListeners();

  // 5. Build term pool and start first round
  buildPool();
  newRound();
}

document.addEventListener('DOMContentLoaded', init);
