/* ══════════════════════════════════════════════════════════════
   SMART HOME CONTROL — script.js  (v3.0)
   · Multilingual voice: Hindi, Marathi, English
   · Voice + Password unlock (passphrase: "Bigg boss has big role")
   · Relay rename (display aliases)
   · Daily timer section + voice timer with "mark as daily?" prompt
   · Performance: debounced renders, optimistic UI
   ══════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const CORRECT_PASSWORD = 'sharez_2004';
const VOICE_PASSPHRASE = 'delta start'; // normalized
const IST_TIMEZONE = 'Asia/Kolkata';
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ─────────────────────────────────────────────
   STATE
───────────────────────────────────────────── */
let db = null;
let relays = {};   // { relayKey: boolean }  (Firebase raw)
let timers = {};   // { timerId: timerObject }
let relayAliases = {};  // { relayKey: "display name" }
let currentEditingTimerId = null;
let currentRenamingKey = null;
let currentTimerTab = 'onetime';  // 'onetime' | 'daily'

// Voice state
let recognition = null;
let voiceMode = 'command';   // 'command' | 'unlock'
let voiceIsListening = false;
let handsFreeMode = false;
let silenceTimer = null;
let audioContext = null;
let analyser = null;
let dataArray = null;
let source = null;
let animationId = null;
let pendingVoiceTimerData = null;   // holds parsed timer data, awaiting daily confirm

/* ─────────────────────────────────────────────
   PASSWORD GATE
───────────────────────────────────────────── */
function switchPwTab(tab) {
  const isPw = tab === 'password';
  document.getElementById('pwPasswordTab').style.display = isPw ? '' : 'none';
  document.getElementById('pwVoiceTab').style.display = isPw ? 'none' : '';
  document.getElementById('tabPw').classList.toggle('active', isPw);
  document.getElementById('tabVoice').classList.toggle('active', !isPw);
  // NOTE: Do NOT auto-start here — mobile browsers block audio
  //       without an explicit user tap on the microphone button
  if (!isPw) {
    const statusEl = document.getElementById('voiceUnlockStatus');
    const btnText = document.getElementById('voiceUnlockBtnText');
    if (statusEl) statusEl.textContent = '👆 Tap the button below to start listening';
    if (btnText) btnText.textContent = 'Tap to Listen';
  }
}

function checkPassword() {
  const val = document.getElementById('pwInput').value;
  const errEl = document.getElementById('pwError');
  if (val === CORRECT_PASSWORD) {
    unlockApp();
  } else {
    errEl.classList.remove('visible');
    void errEl.offsetWidth;
    errEl.classList.add('visible');
    document.getElementById('pwInput').value = '';
    document.getElementById('pwInput').focus();
  }
}

function togglePwEye() {
  const inp = document.getElementById('pwInput');
  const icon = document.getElementById('pwEyeIcon');
  if (inp.type === 'password') { inp.type = 'text'; icon.className = 'fas fa-eye-slash'; }
  else { inp.type = 'password'; icon.className = 'fas fa-eye'; }
}

function unlockApp() {
  const gate = document.getElementById('passwordGate');
  gate.classList.add('fade-out');
  setTimeout(() => {
    gate.style.display = 'none';
    document.getElementById('app').style.display = 'block';
    initApp();
  }, 600);
}

/* ─────────────────────────────────────────────
   VOICE UNLOCK (on password gate)
───────────────────────────────────────────── */
// Track active recognition so we can clean it up between taps
let voiceUnlockRecognition = null;

function startVoiceUnlock() {
  const statusEl = document.getElementById('voiceUnlockStatus');
  const errEl = document.getElementById('pwVoiceError');
  const btn = document.getElementById('voiceUnlockBtn');
  const btnText = document.getElementById('voiceUnlockBtnText');

  // If already listening — stop on second tap (toggle)
  if (voiceUnlockRecognition) {
    try { voiceUnlockRecognition.abort(); } catch (e) { }
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent = 'Tap to Listen';
    statusEl.textContent = '👆 Tap again to retry';
    hideVoiceConfirm();
    return;
  }

  errEl.classList.remove('visible');
  hideVoiceConfirm();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    statusEl.textContent = '⚠ Use Chrome browser — voice not supported here.';
    return;
  }

  const r = new SR();
  voiceUnlockRecognition = r;

  // Use en-US — more reliable on Android Chrome than en-IN
  r.lang = 'en-US';
  r.continuous = false;
  r.interimResults = false;
  r.maxAlternatives = 5;   // check top-5 guesses — improves accuracy

  btn.classList.add('listening');
  btnText.textContent = 'Listening…';
  statusEl.textContent = '🎙 Speak now…';

  try {
    r.start();
  } catch (startErr) {
    // start() can throw if mic permission denied synchronously
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent = 'Tap to Listen';
    statusEl.textContent = '⚠ Microphone error. Allow mic & tap again.';
    return;
  }

  r.onresult = (e) => {
    const shownTranscript = e.results[0][0].transcript.toLowerCase().trim();
    const allAlts = [];
    for (let a = 0; a < e.results[0].length; a++) {
      allAlts.push(e.results[0][a].transcript.toLowerCase().trim());
    }
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    statusEl.textContent = `Heard: "${shownTranscript}"`;

    if (passphraseMatches(allAlts)) {
      statusEl.textContent = '✅ Recognized! Unlocking…';
      btnText.textContent = 'Unlocking…';
      setTimeout(unlockApp, 600);
    } else {
      // Auto-match failed — show manual confirm button as fallback
      btnText.textContent = 'Try Again';
      showVoiceConfirm(shownTranscript);
    }
  };

  r.onerror = (e) => {
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent = 'Tap to Listen';
    const msgs = {
      'no-speech': '🔇 No speech. Tap & speak clearly.',
      'audio-capture': '🎤 No microphone found.',
      'not-allowed': '🚫 Mic blocked — allow in browser settings.',
      'service-not-allowed': '🚫 Mic not allowed. Allow & reload.',
      'network': '📵 Network error. Check connection.',
      'aborted': '⏹ Stopped.',
    };
    statusEl.textContent = msgs[e.error] || `⚠ Error (${e.error}). Tap to retry.`;
  };

  r.onend = () => {
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    if (btnText.textContent === 'Listening…') {
      btnText.textContent = 'Tap to Listen';
      statusEl.textContent = '👆 Tap to try again';
    }
  };
}

// Ultra-lenient matching: passes if any alt has ALL words, or ≥70% words for longer passphrases
function passphraseMatches(alternatives) {
  const words = VOICE_PASSPHRASE.toLowerCase().trim().split(/\s+/);
  for (const alt of alternatives) {
    const altWords = alt.split(/\s+/);
    const allFound = words.every(pw =>
      altWords.some(tw => tw === pw || tw.includes(pw) || pw.includes(tw))
    );
    const noSpace = alt.replace(/\s+/g, '').includes(VOICE_PASSPHRASE.replace(/\s+/g, ''));
    const threshold = words.length <= 2 ? words.length : Math.ceil(words.length * 0.7);
    const matchCount = words.filter(pw =>
      altWords.some(tw => tw === pw || tw.includes(pw) || pw.includes(tw))
    ).length;
    if (allFound || noSpace || matchCount >= threshold) return true;
  }
  return false;
}

// Shows "Yes, Unlock" button when auto-match fails — user confirms manually
function showVoiceConfirm(transcript) {
  let box = document.getElementById('voiceUnlockConfirm');
  if (!box) {
    box = document.createElement('div');
    box.id = 'voiceUnlockConfirm';
    box.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:8px;';
    box.innerHTML = `
      <p style="font-size:13px;color:var(--text-secondary);">Heard: <strong id="voiceConfirmText" style="color:var(--accent-blue);"></strong></p>
      <p style="font-size:12px;color:var(--text-muted);">Is this correct? Tap Unlock.</p>
      <button class="pw-btn" onclick="manualVoiceUnlock()" style="padding:10px;">
        <span class="pw-btn-text"><i class="fas fa-unlock-keyhole"></i> Yes, Unlock</span>
        <div class="pw-btn-shine"></div>
      </button>`;
    document.getElementById('pwVoiceTab').appendChild(box);
  }
  document.getElementById('voiceConfirmText').textContent = '"' + transcript + '"';
  box.style.display = 'flex';
}

function hideVoiceConfirm() {
  const c = document.getElementById('voiceUnlockConfirm');
  if (c) c.style.display = 'none';
}

function manualVoiceUnlock() {
  hideVoiceConfirm();
  unlockApp();
}

/* ─────────────────────────────────────────────
   THEME
───────────────────────────────────────────── */
let currentTheme = localStorage.getItem('sh_theme') || 'dark';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  if (icon) icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
  localStorage.setItem('sh_theme', theme);
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
}

applyTheme(currentTheme);

/* ─────────────────────────────────────────────
   LOADING
───────────────────────────────────────────── */
let loadingCount = 0;
function showLoading() { loadingCount++; document.getElementById('loading').classList.add('show'); }
function hideLoading() { if (--loadingCount <= 0) { loadingCount = 0; document.getElementById('loading').classList.remove('show'); } }

/* ─────────────────────────────────────────────
   CLOCK
───────────────────────────────────────────── */
function updateClocks() {
  const now = moment().tz(IST_TIMEZONE);
  const el1 = document.getElementById('currentTime');
  const el2 = document.getElementById('currentTimeChip');
  if (el1) el1.textContent = now.format('DD/MM/YYYY HH:mm:ss');
  if (el2) el2.textContent = now.format('HH:mm:ss');
}

/* ─────────────────────────────────────────────
   INIT APP
───────────────────────────────────────────── */
function initApp() {
  applyTheme(currentTheme);
  setInterval(updateClocks, 1000);
  updateClocks();

  // Load aliases from localStorage
  try {
    relayAliases = JSON.parse(localStorage.getItem('relayAliases') || '{}');
  } catch (e) { relayAliases = {}; }

  // Persistent delegated click handler for timer Edit/Delete buttons
  // This works across re-renders because it listens on the stable parent containers
  ['oneTimeTimersContainer', 'dailyTimersContainer'].forEach(containerId => {
    document.addEventListener('click', e => {
      const btn = e.target.closest(`#${containerId} button[data-action]`);
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'delete') deleteTimer(id);
      if (action === 'edit') editTimer(id);
    });
  });

  const saved = localStorage.getItem('firebaseConfig');
  if (saved) {
    try {
      const { apiKey, databaseURL } = JSON.parse(saved);
      document.getElementById('apiKey').value = apiKey;
      document.getElementById('databaseURL').value = databaseURL;
      initializeFirebase(apiKey, databaseURL);
    } catch (e) { /* ignore */ }
  }
}

/* ─────────────────────────────────────────────
   FIREBASE
───────────────────────────────────────────── */
function initializeFirebase(apiKey, databaseURL) {
  showLoading();
  try {
    if (firebase.apps.length > 0) firebase.apps.forEach(a => a.delete());
    firebase.initializeApp({ apiKey, databaseURL });
    db = firebase.database();

    document.getElementById('instructionsSection').style.display = 'none';
    document.getElementById('configSection').style.display = 'none';
    document.getElementById('relaysSection').style.display = 'block';
    document.getElementById('timersSection').style.display = 'block';

    loadData();
    startTimerScheduler();
    hideLoading();
  } catch (err) {
    hideLoading();
    alert('Firebase connection failed: ' + err.message);
  }
}

function handleConfigSubmit() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const databaseURL = document.getElementById('databaseURL').value.trim();
  if (!apiKey || !databaseURL) { alert('Please provide both API Key and Database URL.'); return; }
  localStorage.setItem('firebaseConfig', JSON.stringify({ apiKey, databaseURL }));
  initializeFirebase(apiKey, databaseURL);
}

/* ─────────────────────────────────────────────
   LOAD DATA  (real-time listeners)
───────────────────────────────────────────── */
function loadData() {
  if (!db) return;

  db.ref('relays').on('value', snap => {
    relays = snap.val() || {};
    renderRelays();
    updateTimerFormRelays();
  });

  db.ref('timers').on('value', snap => {
    timers = snap.val() || {};
    renderTimers();
  });
}

/* ─────────────────────────────────────────────
   RELAY ALIAS HELPERS
───────────────────────────────────────────── */
function getAlias(key) {
  return relayAliases[key] || key;
}

function saveAliases() {
  localStorage.setItem('relayAliases', JSON.stringify(relayAliases));
}

/* ─────────────────────────────────────────────
   RENDER RELAYS
───────────────────────────────────────────── */
function renderRelays() {
  const container = document.getElementById('relaysContainer');
  const entries = Object.entries(relays).filter(
    ([k, v]) => k && k !== 'undefined' && k.trim() && typeof v === 'boolean'
  );

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-plug"></i>
        <p>No relays found in your database</p>
      </div>`;
    updateRelayCounts(0, 0);
    return;
  }

  let onCount = 0, offCount = 0;

  // Build fragment for performance
  const frag = document.createDocumentFragment();

  entries.forEach(([relay, state]) => {
    const physicallyOn = !state; // active-LOW inversion
    physicallyOn ? onCount++ : offCount++;
    const cls = physicallyOn ? 'on' : 'off';
    const icon = physicallyOn ? 'fa-toggle-on' : 'fa-toggle-off';
    const alias = getAlias(relay);

    // Reuse existing card element if possible (reduces DOM thrash)
    let div = document.getElementById(`rc_${relay}`);
    let isNew = false;
    if (!div) {
      div = document.createElement('div');
      div.id = `rc_${relay}`;
      isNew = true;
    }
    div.className = `relay-card ${cls}`;

    div.innerHTML = `
      <div class="relay-card-header">
        <div class="relay-name-wrap">
          <h3><i class="fas ${icon}"></i> ${escHtml(alias)}</h3>
          <div class="relay-id">${escHtml(relay)}</div>
        </div>
        <div class="relay-header-actions">
          <button class="rename-btn" title="Rename" onclick="openRenameModal('${escAttr(relay)}')">
            <i class="fas fa-pen"></i>
          </button>
          <div class="status-dot"></div>
        </div>
      </div>

      <div class="relay-status-badge">
        <i class="fas fa-circle" style="font-size:8px"></i>
        ${physicallyOn ? 'ON' : 'OFF'}
      </div>

      <div class="big-toggle">
        <div class="toggle-track" onclick="toggleRelay('${escAttr(relay)}', ${physicallyOn}, event)">
          <div class="toggle-knob"></div>
        </div>
      </div>

      <div class="relay-actions">
        <button class="btn btn-success" onclick="toggleRelay('${escAttr(relay)}', true, event)">
          <i class="fas fa-power-off"></i> ON
        </button>
        <button class="btn btn-danger"  onclick="toggleRelay('${escAttr(relay)}', false, event)">
          <i class="fas fa-power-off"></i> OFF
        </button>
      </div>
    `;

    if (isNew) frag.appendChild(div);
  });

  // Remove stale cards
  Array.from(container.children).forEach(child => {
    const key = child.id?.replace('rc_', '');
    if (!relays.hasOwnProperty(key)) child.remove();
  });

  container.appendChild(frag);
  updateRelayCounts(onCount, offCount);
}

function updateRelayCounts(on, off) {
  const onEl = document.getElementById('onCount');
  const offEl = document.getElementById('offCount');
  if (onEl) onEl.textContent = on;
  if (offEl) offEl.textContent = off;
}

/* ─────────────────────────────────────────────
   TOGGLE RELAY  (active-LOW inversion)
───────────────────────────────────────────── */
function toggleRelay(relay, physicalState, event) {
  if (!relay || relay === 'undefined' || !relay.trim()) return;

  // Ripple
  if (event) {
    const card = document.getElementById(`rc_${relay}`);
    if (card) {
      const r = document.createElement('div');
      r.className = 'ripple-effect';
      const rect = card.getBoundingClientRect();
      r.style.left = (event.clientX - rect.left - 30) + 'px';
      r.style.top = (event.clientY - rect.top - 30) + 'px';
      card.appendChild(r);
      setTimeout(() => r.remove(), 500);
    }
  }

  // Optimistic UI update
  relays[relay] = !physicalState;  // active-LOW: physOn=true → Firebase=false
  renderRelays();

  // Firebase write (no show/hide loading — too slow for UX)
  db.ref(`relays/${relay}`).set(!physicalState)
    .catch(err => {
      // Revert optimistic update on error
      relays[relay] = physicalState;
      renderRelays();
      alert('Error updating relay: ' + err.message);
    });
}

/* ─────────────────────────────────────────────
   RENAME RELAY
───────────────────────────────────────────── */
function openRenameModal(relay) {
  currentRenamingKey = relay;
  const inp = document.getElementById('renameInput');
  inp.value = relayAliases[relay] || '';
  document.getElementById('renameModal').classList.add('open');
  setTimeout(() => inp.focus(), 100);
}

function closeRenameModal() {
  document.getElementById('renameModal').classList.remove('open');
  currentRenamingKey = null;
}

function saveRename() {
  const name = document.getElementById('renameInput').value.trim();
  if (!currentRenamingKey) return;
  if (name) relayAliases[currentRenamingKey] = name;
  else delete relayAliases[currentRenamingKey];
  saveAliases();
  renderRelays();
  updateTimerFormRelays();
  closeRenameModal();
}

/* ─────────────────────────────────────────────
   RENDER TIMERS  (tabs: one-time & daily)
───────────────────────────────────────────── */
function switchTimerTab(tab) {
  currentTimerTab = tab;
  const oneTime = document.getElementById('oneTimeTimersContainer');
  const daily = document.getElementById('dailyTimersContainer');
  document.getElementById('tabOneTime').classList.toggle('active', tab === 'onetime');
  document.getElementById('tabDaily').classList.toggle('active', tab === 'daily');
  oneTime.style.display = tab === 'onetime' ? '' : 'none';
  daily.style.display = tab === 'daily' ? '' : 'none';
}

function renderTimers() {
  const oneTimeContainer = document.getElementById('oneTimeTimersContainer');
  const dailyContainer = document.getElementById('dailyTimersContainer');
  oneTimeContainer.innerHTML = '';
  dailyContainer.innerHTML = '';

  const entries = Object.entries(timers).filter(
    ([, t]) => t && t.relay && t.relay !== 'undefined' && t.relay.trim()
  );

  if (entries.length === 0) {
    const empty = `<div class="empty-state"><i class="fas fa-clock"></i><p>No timers configured yet</p></div>`;
    oneTimeContainer.innerHTML = empty;
    dailyContainer.innerHTML = empty;
    return;
  }

  let oneTimeCount = 0, dailyCount = 0;

  entries.forEach(([id, timer]) => {
    const activeDays = timer.days
      ? timer.days.map((a, i) => a ? dayNames[i].slice(0, 3) : null).filter(Boolean).join(', ')
      : 'None';

    const alias = getAlias(timer.relay);
    const isDailyBadge = timer.isDaily
      ? `<span class="daily-badge"><i class="fas fa-repeat"></i> Daily</span>`
      : '';

    const div = document.createElement('div');
    div.className = `timer-card ${timer.active ? 'active' : 'inactive'}`;
    // Use data-id attribute to avoid any inline quoting issues with Firebase push keys
    div.dataset.timerId = id;
    div.innerHTML = `
      ${isDailyBadge}
      <h4><i class="fas fa-toggle-on"></i> ${escHtml(alias)} — <span style="color:var(--accent-green)">${timer.action}</span></h4>
      <p><i class="fas fa-clock"></i> ${timer.startTime}${timer.endTime ? ' → ' + timer.endTime : ''}</p>
      <p><i class="fas fa-calendar-week"></i> ${activeDays}</p>
      <div class="timer-actions">
        <button class="btn btn-edit"   data-action="edit"   data-id="${id}"><i class="fas fa-pen"></i> Edit</button>
        <button class="btn btn-danger" data-action="delete" data-id="${id}"><i class="fas fa-trash"></i> Delete</button>
      </div>
    `;

    if (timer.isDaily) { dailyContainer.appendChild(div); dailyCount++; }
    else { oneTimeContainer.appendChild(div); oneTimeCount++; }
  });

  if (oneTimeCount === 0) oneTimeContainer.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-day"></i><p>No one-time timers</p></div>`;
  if (dailyCount === 0) dailyContainer.innerHTML = `<div class="empty-state"><i class="fas fa-repeat"></i><p>No daily schedules</p></div>`;
}

/* ─────────────────────────────────────────────
   TIMER FORM — RELAY DROPDOWN
───────────────────────────────────────────── */
function updateTimerFormRelays() {
  const sel = document.getElementById('timerRelay');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Choose a relay…</option>';
  Object.keys(relays).forEach(relay => {
    if (!relay || relay === 'undefined' || !relay.trim()) return;
    const opt = document.createElement('option');
    opt.value = relay;
    opt.textContent = getAlias(relay);
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

/* ─────────────────────────────────────────────
   DAILY SWITCH (in modal)
───────────────────────────────────────────── */
function toggleDailySwitch() {
  const wrap = document.getElementById('dailySwitchWrap');
  const input = document.getElementById('timerIsDaily');
  const isOn = input.value === '1';
  input.value = isOn ? '0' : '1';
  wrap.classList.toggle('active', !isOn);
}

function setDailySwitchState(on) {
  document.getElementById('timerIsDaily').value = on ? '1' : '0';
  document.getElementById('dailySwitchWrap').classList.toggle('active', on);
}

/* ─────────────────────────────────────────────
   TIMER MODAL
───────────────────────────────────────────── */
function openTimerModal() {
  currentEditingTimerId = null;
  document.getElementById('modalTitle').innerHTML = '<i class="fas fa-clock"></i> Add New Timer';
  document.getElementById('timerRelay').value = '';
  document.getElementById('timerAction').value = '';
  document.getElementById('timerStartTime').value = '';
  document.getElementById('timerEndTime').value = '';
  setDailySwitchState(false);
  resetDayChips();
  document.getElementById('timerModal').classList.add('open');
}

function closeTimerModal() {
  document.getElementById('timerModal').classList.remove('open');
  currentEditingTimerId = null;
}

function toggleDay(i) {
  const chip = document.getElementById(`dc${i}`);
  const cb = document.getElementById(`day${i}`);
  chip.classList.toggle('active');
  cb.checked = chip.classList.contains('active');
}

function resetDayChips() {
  for (let i = 0; i < 7; i++) {
    document.getElementById(`dc${i}`).classList.remove('active');
    document.getElementById(`day${i}`).checked = false;
  }
}

function editTimer(timerId) {
  const timer = timers[timerId];
  if (!timer) return;
  currentEditingTimerId = timerId;
  document.getElementById('modalTitle').innerHTML = '<i class="fas fa-pen"></i> Edit Timer';
  document.getElementById('timerRelay').value = timer.relay || '';
  document.getElementById('timerAction').value = timer.action || '';
  document.getElementById('timerStartTime').value = timer.startTime || '';
  document.getElementById('timerEndTime').value = timer.endTime || '';
  setDailySwitchState(!!timer.isDaily);
  resetDayChips();
  if (timer.days) timer.days.forEach((active, i) => {
    if (active) {
      document.getElementById(`dc${i}`).classList.add('active');
      document.getElementById(`day${i}`).checked = true;
    }
  });
  document.getElementById('timerModal').classList.add('open');
}

function deleteTimer(timerId) {
  if (!confirm('Delete this timer?')) return;
  showLoading();
  db.ref(`timers/${timerId}`).remove()
    .then(() => {
      // Also delete from local cache and re-render immediately
      delete timers[timerId];
      hideLoading();
      renderTimers();
    })
    .catch(err => { hideLoading(); alert('Error: ' + err.message); });
}

function handleTimerSubmit() {
  const relay = document.getElementById('timerRelay').value;
  const action = document.getElementById('timerAction').value;
  const startTime = document.getElementById('timerStartTime').value;
  const endTime = document.getElementById('timerEndTime').value;
  const isDaily = document.getElementById('timerIsDaily').value === '1';

  if (!relay || relay === 'undefined' || !action || !startTime || !relays.hasOwnProperty(relay)) {
    alert('Please select a valid relay, action, and start time.'); return;
  }
  const days = Array.from({ length: 7 }, (_, i) => document.getElementById(`day${i}`).checked);
  if (!days.some(Boolean)) { alert('Please select at least one day.'); return; }

  saveTimerData({ relay, action, startTime, endTime: endTime || null, days, active: true, isDaily });
}

function saveTimerData(timerData) {
  showLoading();
  const refPath = currentEditingTimerId
    ? `timers/${currentEditingTimerId}`
    : `timers/${db.ref('timers').push().key}`;

  db.ref(refPath).set(timerData)
    .then(() => {
      updateRelayForTimer(timerData);
      hideLoading();
      closeTimerModal();
    })
    .catch(err => { hideLoading(); alert('Error saving timer: ' + err.message); });
}

/* ─────────────────────────────────────────────
   CREDENTIALS MODAL
───────────────────────────────────────────── */
function showCredentialsModal() {
  const saved = localStorage.getItem('firebaseConfig');
  if (saved) {
    try {
      const { apiKey, databaseURL } = JSON.parse(saved);
      document.getElementById('newApiKey').value = apiKey;
      document.getElementById('newDatabaseURL').value = databaseURL;
    } catch (e) { }
  }
  document.getElementById('credentialsModal').classList.add('open');
}

function closeCredentialsModal() {
  document.getElementById('credentialsModal').classList.remove('open');
}

function handleCredentialsSubmit() {
  const apiKey = document.getElementById('newApiKey').value.trim();
  const databaseURL = document.getElementById('newDatabaseURL').value.trim();
  if (!apiKey || !databaseURL) { alert('Please provide both fields.'); return; }
  localStorage.setItem('firebaseConfig', JSON.stringify({ apiKey, databaseURL }));
  closeCredentialsModal();
  document.getElementById('instructionsSection').style.display = 'block';
  document.getElementById('configSection').style.display = 'block';
  document.getElementById('relaysSection').style.display = 'none';
  document.getElementById('timersSection').style.display = 'none';
  document.getElementById('apiKey').value = apiKey;
  document.getElementById('databaseURL').value = databaseURL;
  alert('Credentials updated! Click "Connect to Firebase" to reconnect.');
}

function modalBackdropClick(event, modalId) {
  if (event.target.id === modalId) {
    document.getElementById(modalId).classList.remove('open');
    if (modalId === 'timerModal') currentEditingTimerId = null;
    if (modalId === 'renameModal') currentRenamingKey = null;
  }
}

/* ─────────────────────────────────────────────
   TIMER RELAY UPDATE
───────────────────────────────────────────── */
function updateRelayForTimer(timer) {
  if (!timer || !timer.active || !timer.relay || !timer.startTime || !timer.days
    || timer.relay === 'undefined' || !relays.hasOwnProperty(timer.relay)) return;

  const now = moment().tz(IST_TIMEZONE);
  const currentDay = (now.day() + 6) % 7;
  if (!timer.days[currentDay]) return;

  const startTime = moment.tz(`${now.format('YYYY-MM-DD')} ${timer.startTime}`, 'YYYY-MM-DD HH:mm', IST_TIMEZONE);
  let endTime = timer.endTime
    ? moment.tz(`${now.format('YYYY-MM-DD')} ${timer.endTime}`, 'YYYY-MM-DD HH:mm', IST_TIMEZONE)
    : null;

  if (endTime && endTime.isBefore(startTime)) endTime.add(1, 'day');

  if (now.isSameOrAfter(startTime) && (!endTime || now.isBefore(endTime))) {
    db.ref(`relays/${timer.relay}`).set(timer.action !== 'ON');
  } else if (endTime && now.isSameOrAfter(endTime)) {
    db.ref(`relays/${timer.relay}`).set(true);
  }
}

/* ─────────────────────────────────────────────
   TIMER SCHEDULER  (runs every 30s)
───────────────────────────────────────────── */
function startTimerScheduler() {
  function tick() {
    if (!db) return;
    const now = moment().tz(IST_TIMEZONE);
    const currentDay = (now.day() + 6) % 7;
    let nextTimer = null, nextTimerDate = null;

    Object.values(timers).forEach(timer => {
      if (!timer?.active || !timer.days?.[currentDay] || !timer.relay
        || timer.relay === 'undefined' || !relays.hasOwnProperty(timer.relay)) return;

      const startTime = moment.tz(`${now.format('YYYY-MM-DD')} ${timer.startTime}`, 'YYYY-MM-DD HH:mm', IST_TIMEZONE);
      let endTime = timer.endTime
        ? moment.tz(`${now.format('YYYY-MM-DD')} ${timer.endTime}`, 'YYYY-MM-DD HH:mm', IST_TIMEZONE)
        : null;
      if (endTime && endTime.isBefore(startTime)) endTime.add(1, 'day');

      if (now.isSameOrAfter(startTime) && (!endTime || now.isBefore(endTime))) {
        db.ref(`relays/${timer.relay}`).set(timer.action !== 'ON');
      } else if (endTime && now.isSameOrAfter(endTime)) {
        db.ref(`relays/${timer.relay}`).set(true);
      }
    });

    // Find next upcoming timer
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const checkDate = moment(now).add(dayOffset, 'days');
      const checkDay = (checkDate.day() + 6) % 7;
      Object.values(timers).forEach(timer => {
        if (!timer?.active || !timer.days?.[checkDay] || !timer.relay
          || timer.relay === 'undefined' || !relays.hasOwnProperty(timer.relay)) return;
        const startTime = moment.tz(`${checkDate.format('YYYY-MM-DD')} ${timer.startTime}`, 'YYYY-MM-DD HH:mm', IST_TIMEZONE);
        if (dayOffset === 0 && startTime.isSameOrBefore(now)) return;
        if (!nextTimer || startTime.isBefore(nextTimerDate)) { nextTimer = timer; nextTimerDate = startTime; }
      });
      if (nextTimer) break;
    }

    const el = document.getElementById('nextTimer');
    if (!el) return;
    if (nextTimer && nextTimerDate) {
      el.innerHTML = `<i class="fas fa-clock"></i> Next: <strong>${escHtml(getAlias(nextTimer.relay))}</strong> turns
        <strong>${nextTimer.action}</strong> at <strong>${nextTimerDate.format('DD/MM HH:mm')}</strong> · ${nextTimerDate.fromNow()}`;
    } else {
      el.innerHTML = `<i class="fas fa-info-circle"></i> No upcoming timers scheduled`;
    }
  }

  tick();
  setInterval(tick, 30000);
}

/* ═══════════════════════════════════════════════════════════════
   AI VOICE ASSISTANT
   Language: English / Hinglish (en-IN)
   Commands understood:
     Relay: "turn on fan", "fan on karo", "light band karo"
     Timer: "light 6pm se 7am tak on karo"
   ═══════════════════════════════════════════════════════════════ */

function startVoiceCommand() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice not supported. Please use Chrome or Edge.'); return; }
  if (voiceIsListening) { stopVoiceCommand(); return; }

  voiceIsListening = true;
  document.getElementById('voiceOverlay').classList.add('open');
  document.getElementById('voiceFab').classList.add('listening');
  document.getElementById('voiceFabIcon').className = 'fas fa-stop';
  document.getElementById('voiceStatus').textContent = 'Listening…';
  document.getElementById('voiceTranscript').textContent = '';
  document.getElementById('voiceDailyPrompt').style.display = 'none';
  playVoiceFeedback('start');

  recognition = new SR();
  recognition.continuous = handsFreeMode;
  recognition.interimResults = true;
  recognition.lang = 'en-IN';   // Indian English / Hinglish
  recognition.maxAlternatives = 5;

  initVisualizer();

  recognition.onresult = (e) => {
    let interim = '', final = '';
    const allAlts = [];

    // Clear previous silence timer
    if (silenceTimer) clearTimeout(silenceTimer);

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const t = res[0].transcript;
      if (res.isFinal) {
        final += t;
        // Collect all alternatives for the final result
        for (let j = 0; j < res.length; j++) {
          allAlts.push(res[j].transcript.toLowerCase().trim());
        }
      } else {
        interim += t;
      }
    }

    document.getElementById('voiceTranscript').textContent = final || interim;
    
    // Auto-process on silence (The "Google Assistant" FAST feel)
    if (interim && !final) {
      silenceTimer = setTimeout(() => {
        const textToProcess = interim.toLowerCase().trim();
        document.getElementById('voiceStatus').textContent = 'Processing...';
        processVoiceCommand(textToProcess);
        // Note: we don't stop recognition here if in handsFreeMode
        if (!handsFreeMode) stopVoiceCommand();
      }, 800); // 0.8 seconds of silence triggers the command — snappy!
    }

    if (final) {
      processVoiceCommand(allAlts.length > 0 ? allAlts : [final.toLowerCase().trim()]);
    }
  };

  recognition.onerror = (e) => {
    document.getElementById('voiceStatus').textContent = '⚠ Error: ' + e.error + '. Try again.';
    setTimeout(stopVoiceCommand, 2000);
  };

  recognition.onend = () => {
    if (voiceIsListening && document.getElementById('voiceDailyPrompt').style.display === 'none') {
      stopVoiceCommand();
    }
  };

  recognition.start();
}

function stopVoiceCommand() {
  if (voiceIsListening) playVoiceFeedback('stop');
  voiceIsListening = false;
  if (silenceTimer) clearTimeout(silenceTimer);
  if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
  stopVisualizer();
  document.getElementById('voiceOverlay').classList.remove('open');
  document.getElementById('voiceFab').classList.remove('listening');
  document.getElementById('voiceFabIcon').className = 'fas fa-microphone';
  document.getElementById('voiceFab').classList.remove('held');
  pendingVoiceTimerData = null;
  document.getElementById('voiceDailyPrompt').style.display = 'none';
}

/* ─────────────────────────────────────────────
   VOICE COMMAND  (tap mic button → speak → result)
   Works on both desktop and mobile
───────────────────────────────────────────── */
let holdToSpeakRecognition = null;
let holdFinalTranscript    = '';   // module-level so releaseHoldToSpeak can read it
let isHoldingMic           = false;

function startHoldToSpeak() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice not supported. Use Chrome browser.'); return; }

  // If already a recognition running — stop it (toggle)
  if (holdToSpeakRecognition) {
    try { holdToSpeakRecognition.abort(); } catch (e) {}
    holdToSpeakRecognition = null;
    isHoldingMic = false;
    return;
  }

  isHoldingMic         = true;
  holdFinalTranscript  = '';

  // Show overlay immediately so user sees feedback
  voiceIsListening = true;
  document.getElementById('voiceOverlay').classList.add('open');
  document.getElementById('voiceFab').classList.add('listening', 'held');
  document.getElementById('voiceFabIcon').className = 'fas fa-stop';
  document.getElementById('voiceStatus').textContent = '🎙 Listening… speak your command';
  document.getElementById('voiceTranscript').textContent = '';
  document.getElementById('voiceDailyPrompt').style.display = 'none';

  const holdIndicator = document.getElementById('holdIndicator');
  if (holdIndicator) holdIndicator.style.display = 'block';

  initVisualizer();

  const r = new SR();
  holdToSpeakRecognition = r;
  r.lang           = 'en-IN';
  r.continuous     = false;      // single utterance — fires onresult once
  r.interimResults = true;
  r.maxAlternatives = 5;

  r.onresult = (e) => {
    let interim = '', final = '';
    const allAlts = [];
    
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const t = res[0].transcript;
      if (res.isFinal) {
        final += t;
        for (let j = 0; j < res.length; j++) {
          allAlts.push(res[j].transcript.toLowerCase().trim());
        }
      } else {
        interim += t;
      }
    }
    // Show live waveform text
    document.getElementById('voiceTranscript').textContent = final || interim;
    if (final) {
      holdFinalTranscript = final.toLowerCase().trim();
      processVoiceCommand(allAlts.length > 0 ? allAlts : [holdFinalTranscript]);
      // Note: we still wait for user to release or auto-end
    }
  };

  r.onerror = (e) => {
    const msgs = {
      'no-speech':   '🔇 No speech detected — tap & speak',
      'not-allowed': '🚫 Mic blocked — allow mic in browser',
      'network':     '📵 Network error',
    };
    document.getElementById('voiceStatus').textContent =
      msgs[e.error] || `⚠ Error: ${e.error}`;
    setTimeout(() => _cleanupHold(), 2000);
  };

  r.onend = () => {
    // If onresult never fired (user was silent), clean up
    if (!holdFinalTranscript) {
      document.getElementById('voiceStatus').textContent = '🔇 Nothing heard — tap again';
      setTimeout(() => _cleanupHold(), 1500);
    }
  };

  try { r.start(); }
  catch (startErr) {
    document.getElementById('voiceStatus').textContent = '⚠ Mic error — allow microphone';
    _cleanupHold();
  }
}

function releaseHoldToSpeak() {
  // No-op: recognition auto-ends on silence since continuous=false
  // Kept for HTML ontouchend/onmouseup compatibility
}

function _cleanupHold() {
  isHoldingMic = false;
  holdFinalTranscript = '';
  if (holdToSpeakRecognition) {
    try { holdToSpeakRecognition.stop(); } catch (e) {}
    holdToSpeakRecognition = null;
  }
  stopVisualizer();
  document.getElementById('voiceFab').classList.remove('held');
  const hi = document.getElementById('holdIndicator');
  if (hi) hi.style.display = 'none';
  // Close overlay after short delay so user can read result
  setTimeout(() => {
    voiceIsListening = false;
    document.getElementById('voiceOverlay').classList.remove('open');
    document.getElementById('voiceFab').classList.remove('listening');
    document.getElementById('voiceFabIcon').className = 'fas fa-microphone';
  }, 2000);
}

/* ─────────────────────────────────────────────
   VOICE ASSISTANT V2 — ENHANCEMENTS
───────────────────────────────────────────── */
function toggleHandsFree() {
  handsFreeMode = !handsFreeMode;
  const btn = document.getElementById('handsFreeToggle');
  if (btn) {
    btn.classList.toggle('active', handsFreeMode);
    btn.querySelector('span').textContent = `Hands-Free: ${handsFreeMode ? 'ON' : 'OFF'}`;
  }
}

async function initVisualizer() {
  if (audioContext) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    drawVisualizer();
  } catch (err) {
    console.error('Visualizer init failed:', err);
  }
}

function drawVisualizer() {
  const canvas = document.getElementById('voiceVisualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  animationId = requestAnimationFrame(drawVisualizer);
  analyser.getByteFrequencyData(dataArray);

  ctx.clearRect(0, 0, width, height);
  
  const barWidth = (width / dataArray.length) * 2.5;
  let barHeight;
  let x = 0;

  // Draw symmetric bars from center
  const centerX = width / 2;
  const avg = dataArray.reduce((p, c) => p + c, 0) / dataArray.length;
  
  // Pulse the mic icon if sound level is high
  const micIcon = document.querySelector('.voice-mic-icon');
  if (micIcon) {
    if (avg > 40) micIcon.classList.add('active');
    else micIcon.classList.remove('active');
  }

  for (let i = 0; i < dataArray.length; i++) {
    barHeight = (dataArray[i] / 255) * height;
    
    // Gradient color based on intensity
    const g = ctx.createLinearGradient(0, height, 0, 0);
    g.addColorStop(0, '#4d9fff');
    g.addColorStop(1, '#00e5a0');
    ctx.fillStyle = g;

    // Draw right side
    ctx.fillRect(centerX + x, (height - barHeight) / 2, barWidth - 1, barHeight);
    // Draw left side
    ctx.fillRect(centerX - x - barWidth, (height - barHeight) / 2, barWidth - 1, barHeight);

    x += barWidth;
  }
}

function stopVisualizer() {
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
}

function playVoiceFeedback(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'start') {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
    } else {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
    }
    
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch (e) { /* audio blocked */ }
}

/* ─────────────────────────────────────────────
   VOICE COMMAND PARSER (V2 - Multi-Alt)
───────────────────────────────────────────── */
function processVoiceCommand(input) {
  // Convert input to array of alternatives if it's just a string
  const alternatives = Array.isArray(input) ? input : [input];
  let matchedCmd = null;

  for (const alt of alternatives) {
    const norm = normalize(alt);
    document.getElementById('voiceStatus').textContent = 'Processing: "' + alt + '"';

    // 1. Try timer command
    const timerData = parseVoiceTimer(norm);
    if (timerData) {
      pendingVoiceTimerData = timerData;
      document.getElementById('voiceStatus').textContent = `⏱ Timer: ${getAlias(timerData.relay)} ${timerData.action} ${timerData.startTime}${timerData.endTime ? ' → ' + timerData.endTime : ''}`;
      document.getElementById('voiceDailyPrompt').style.display = 'block';
      matchedCmd = 'TIMER';
      break;
    }

    // 2. Try relay ON/OFF command
    const relayCmd = parseRelayCommand(norm);
    if (relayCmd) {
      document.getElementById('voiceStatus').textContent = `✅ ${getAlias(relayCmd.relay)} → ${relayCmd.action}`;
      toggleRelay(relayCmd.relay, relayCmd.action === 'ON', null);
      matchedCmd = 'RELAY';
      break;
    }
  }

  if (matchedCmd) {
    if (handsFreeMode && matchedCmd === 'RELAY') {
      // In hands-free, don't close overlay, just reset for next command
      setTimeout(() => {
        document.getElementById('voiceStatus').textContent = 'Ready for next command…';
        document.getElementById('voiceTranscript').textContent = '';
      }, 2000);
    } else if (matchedCmd === 'RELAY') {
      setTimeout(stopVoiceCommand, 1500);
    }
    // If it's a TIMER, it's waiting for User Confirm (Daily?), so we don't close.
  } else {
    document.getElementById('voiceStatus').textContent = '❓ Not understood. Try: "fan on karo"';
    if (!handsFreeMode) setTimeout(stopVoiceCommand, 3000);
  }
}

/* ─────────────────────────────────────────────
   VOICE: CONFIRM DAILY
───────────────────────────────────────────── */
function confirmDailyFromVoice(isDaily) {
  if (!pendingVoiceTimerData) { stopVoiceCommand(); return; }
  const timerData = { ...pendingVoiceTimerData, isDaily };
  currentEditingTimerId = null;
  document.getElementById('voiceStatus').textContent = isDaily ? '✅ Saving as Daily Timer…' : '✅ Saving as One-time Timer…';
  document.getElementById('voiceDailyPrompt').style.display = 'none';

  showLoading();
  const refPath = `timers/${db.ref('timers').push().key}`;
  db.ref(refPath).set(timerData)
    .then(() => {
      updateRelayForTimer(timerData);
      hideLoading();
      setTimeout(stopVoiceCommand, 1000);
    })
    .catch(err => { hideLoading(); alert('Error saving timer: ' + err.message); stopVoiceCommand(); });
}

/* ─────────────────────────────────────────────
   PARSE RELAY COMMAND
   Understands:
     English:  "turn on fan", "turn off light", "fan on", "light off"
     Hindi:    "fan on karo", "light band karo", "fan chalu karo"
     Marathi:  "pankha chalu kar", "diva band kar"
   Also uses relay aliases
───────────────────────────────────────────── */
function parseRelayCommand(norm) {
  const onWords  = ['on', 'chalu', 'chalv', 'chalo', 'jalao', 'jala', 'lav', 'laga', 'shuru', 'start', 'open', 'rakh', 'rakho', 'rako'];
  const offWords  = ['off', 'band', 'bandh', 'stop', 'bujhao', 'bujha', 'close', 'bund'];

  // Find which relay is mentioned (check alias first, then raw key)
  let matchedRelay = null;
  const relayKeys = Object.keys(relays).filter(k => k && k !== 'undefined' && k.trim());

  // Sort longer aliases first to prefer specific matches
  const sortedKeys = relayKeys.slice().sort((a, b) => {
    const al = normalize(getAlias(a)), bl = normalize(getAlias(b));
    return bl.length - al.length;
  });

  for (const key of sortedKeys) {
    const aliasNorm = normalize(getAlias(key));
    const keyNorm = normalize(key);
    if (norm.includes(aliasNorm) || norm.includes(keyNorm)) {
      matchedRelay = key;
      break;
    }
  }

  if (!matchedRelay) return null;

  const isOn = onWords.some(w => norm.includes(w));
  const isOff = offWords.some(w => norm.includes(w));

  if (!isOn && !isOff) return null;

  return { relay: matchedRelay, action: isOn ? 'ON' : 'OFF' };
}

/* ─────────────────────────────────────────────
   PARSE VOICE TIMER
   Examples:
     "light 6pm se 7am tak on karo"       → timer ON 06:00 → 07:00
     "fan 6pm se 9am tak band karo"        → timer OFF 18:00 → 09:00
     "turn on light from 6pm to 10pm"
     "6 baje se 7 baje tak fan on karo"
───────────────────────────────────────────── */
function parseVoiceTimer(norm) {
  // Detect time-range keywords
  const hasRange = norm.includes('se') || norm.includes('se ') ||
    norm.includes('from') || norm.includes('tak') ||
    norm.includes('to ') || norm.includes('baje') ||
    norm.includes('pm') || norm.includes('am') ||
    /\d+\s*:\s*\d+/.test(norm) || /\d+\s*baj/.test(norm);

  if (!hasRange) return null;

  // Find relay
  const relayKeys = Object.keys(relays).filter(k => k && k !== 'undefined' && k.trim());
  const sortedKeys = relayKeys.slice().sort((a, b) => {
    const al = normalize(getAlias(a)), bl = normalize(getAlias(b));
    return bl.length - al.length;
  });

  let matchedRelay = null;
  for (const key of sortedKeys) {
    const aliasNorm = normalize(getAlias(key));
    const keyNorm = normalize(key);
    if (norm.includes(aliasNorm) || norm.includes(keyNorm)) {
      matchedRelay = key;
      break;
    }
  }
  if (!matchedRelay) return null;

  // Parse times
  const times = extractTimes(norm);
  if (times.length < 1) return null;

  // Detect action
  const onWords  = ['on', 'chalu', 'jalao', 'lav', 'shuru', 'start', 'chalo', 'laga', 'open', 'rakh', 'rakho', 'rako'];
  const offWords  = ['off', 'band', 'bandh', 'stop', 'bujhao', 'close'];
  // 'rako' alone means keep/maintain — treat as ON unless 'off/band' also found
  const isOff = offWords.some(w => norm.includes(w));
  const isOn  = !isOff && onWords.some(w => norm.includes(w));
  const action = isOff ? 'OFF' : 'ON';

  // All days selected if timer set by voice
  const days = Array(7).fill(true);

  return {
    relay: matchedRelay,
    action,
    startTime: times[0],
    endTime: times[1] || null,
    days,
    active: true
  };
}

/* ─────────────────────────────────────────────
   EXTRACT TIMES from normalized string
   supports: 6pm 6am 18:00 6:00pm 6 baje sham 
───────────────────────────────────────────── */
function extractTimes(norm) {
  const times = [];

  // Pattern: 6pm, 6am, 18pm (ignore), 6:30pm, 6:30am, 18:00, 06:00
  const patterns = [
    /(\d{1,2}):(\d{2})\s*(am|pm)?/gi,
    /(\d{1,2})\s*(am|pm)/gi,
    /(\d{1,2})\s*baje/gi,
  ];

  let foundNums = [];

  // Type 1: HH:MM with optional am/pm
  const matches1 = [...norm.matchAll(/(\d{1,2}):(\d{2})\s*(am|pm)?/gi)];
  matches1.forEach(m => {
    let h = parseInt(m[1]), mi = parseInt(m[2]);
    const ampm = m[3]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    times.push(pad(h) + ':' + pad(mi));
  });

  if (times.length === 0) {
    // Type 2: single hour with am/pm
    const matches2 = [...norm.matchAll(/(\d{1,2})\s*(am|pm)/gi)];
    matches2.forEach(m => {
      let h = parseInt(m[1]);
      const ampm = m[2].toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      times.push(pad(h) + ':00');
    });
  }

  if (times.length === 0) {
    // Type 3: "6 baje" "7 baje" — contextual: if "sham/evening" then pm else am
    const matches3 = [...norm.matchAll(/(\d{1,2})\s*baje/gi)];
    matches3.forEach(m => {
      let h = parseInt(m[1]);
      const before = norm.substring(0, m.index);
      if (before.includes('sham') || before.includes('evening') || before.includes('shaam')) {
        if (h < 12) h += 12;
      }
      times.push(pad(h) + ':00');
    });
  }

  return times.slice(0, 2);
}

function pad(n) { return String(n).padStart(2, '0'); }

/* ─────────────────────────────────────────────
   NORMALIZE string (lowercase, trim spaces,
   remove punctuation, normalize hindi diacritics)
───────────────────────────────────────────── */
function normalize(str) {
  return str.toLowerCase()
    .replace(/[^\u0900-\u097F\u0000-\u007F\s]/g, '')  // keep Hindi + ASCII
    .replace(/\s+/g, ' ')
    .trim();
}

/* ─────────────────────────────────────────────
   SECURITY HELPERS
───────────────────────────────────────────── */
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escAttr(str) {
  return String(str).replace(/['"]/g, c => c === "'" ? '\\x27' : '\\x22');
}
