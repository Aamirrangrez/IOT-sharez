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
let pendingVoiceTimerData = null;   // holds parsed timer data, awaiting daily confirm

/* ─────────────────────────────────────────────
   PASSWORD GATE
───────────────────────────────────────────── */
function switchPwTab(tab) {
  const isPw = tab === 'password';
  document.getElementById('pwPasswordTab').style.display = isPw ? '' : 'none';
  document.getElementById('pwVoiceTab').style.display    = isPw ? 'none' : '';
  document.getElementById('tabPw').classList.toggle('active', isPw);
  document.getElementById('tabVoice').classList.toggle('active', !isPw);
  // NOTE: Do NOT auto-start here — mobile browsers block audio
  //       without an explicit user tap on the microphone button
  if (!isPw) {
    const statusEl  = document.getElementById('voiceUnlockStatus');
    const btnText   = document.getElementById('voiceUnlockBtnText');
    if (statusEl)  statusEl.textContent  = '👆 Tap the button below to start listening';
    if (btnText)   btnText.textContent   = 'Tap to Listen';
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
  const errEl    = document.getElementById('pwVoiceError');
  const btn      = document.getElementById('voiceUnlockBtn');
  const btnText  = document.getElementById('voiceUnlockBtnText');

  // If already listening — stop on second tap (toggle)
  if (voiceUnlockRecognition) {
    try { voiceUnlockRecognition.abort(); } catch(e) {}
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent  = 'Tap to Listen';
    statusEl.textContent = '👆 Tap again to retry';
    return;
  }

  errEl.classList.remove('visible');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    statusEl.textContent = '⚠ Use Chrome browser — voice not supported here.';
    return;
  }

  const r = new SR();
  voiceUnlockRecognition = r;

  // Use en-US — more reliable on Android Chrome than en-IN
  r.lang            = 'en-US';
  r.continuous      = false;
  r.interimResults  = false;
  r.maxAlternatives = 5;   // check top-5 guesses — improves accuracy

  btn.classList.add('listening');
  btnText.textContent  = 'Listening…';
  statusEl.textContent = '🎙 Speak now…';

  try {
    r.start();
  } catch(startErr) {
    // start() can throw if mic permission denied synchronously
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent  = 'Tap to Listen';
    statusEl.textContent = '⚠ Microphone error. Allow mic & tap again.';
    return;
  }

  r.onresult = (e) => {
    let shownTranscript = e.results[0][0].transcript.toLowerCase().trim();
    let matched = false;

    // Check ALL 5 alternatives — mobile often puts correct answer in alt 2-5
    for (let a = 0; a < e.results[0].length; a++) {
      const alt  = e.results[0][a].transcript.toLowerCase().trim();
      const passphraseWords = VOICE_PASSPHRASE.toLowerCase().trim().split(/\s+/);
      const altWords        = alt.split(/\s+/);
      const allWordsFound   = passphraseWords.every(pw =>
        altWords.some(tw => tw === pw || tw.startsWith(pw) || pw.startsWith(tw))
      );
      const noSpaceMatch = alt.replace(/\s+/g,'').includes(VOICE_PASSPHRASE.replace(/\s+/g,''));
      if (allWordsFound || noSpaceMatch) { matched = true; break; }
    }

    voiceUnlockRecognition = null;
    statusEl.textContent   = `Heard: "${shownTranscript}"`;

    if (matched) {
      statusEl.textContent = '✅ Recognized! Unlocking…';
      btn.classList.remove('listening');
      btnText.textContent  = 'Unlocking…';
      setTimeout(unlockApp, 600);
    } else {
      errEl.classList.remove('visible');
      void errEl.offsetWidth;
      errEl.classList.add('visible');
      btn.classList.remove('listening');
      btnText.textContent = 'Try Again';
    }
  };

  r.onerror = (e) => {
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    btnText.textContent = 'Tap to Listen';
    const msgs = {
      'no-speech':          '🔇 No speech. Tap & speak clearly.',
      'audio-capture':      '🎤 No microphone found.',
      'not-allowed':        '🚫 Mic blocked — allow in browser settings.',
      'service-not-allowed':'🚫 Mic not allowed. Allow & reload.',
      'network':            '📵 Network error. Check connection.',
      'aborted':            '⏹ Stopped.',
    };
    statusEl.textContent = msgs[e.error] || `⚠ Error (${e.error}). Tap to retry.`;
  };

  r.onend = () => {
    voiceUnlockRecognition = null;
    btn.classList.remove('listening');
    if (btnText.textContent === 'Listening…') {
      btnText.textContent  = 'Tap to Listen';
      statusEl.textContent = '👆 Tap to try again';
    }
  };
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
   Supports: Hindi (hi-IN), Marathi (mr-IN), English (en-IN)
   Commands understood:
     Relay control: "fan on karo", "light band karo", "turn on relay1"
     Timer (voice): "light 6pm se 9am tak on karo"
   ═══════════════════════════════════════════════════════════════ */

const LANG_CODES = ['hi-IN', 'mr-IN', 'en-IN'];
let langIndex = 0;

function startVoiceCommand() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice recognition not supported in this browser. Please use Chrome or Edge.'); return; }
  if (voiceIsListening) { stopVoiceCommand(); return; }

  voiceIsListening = true;
  document.getElementById('voiceOverlay').classList.add('open');
  document.getElementById('voiceFab').classList.add('listening');
  document.getElementById('voiceFabIcon').className = 'fas fa-stop';
  document.getElementById('voiceStatus').textContent = 'Listening…';
  document.getElementById('voiceTranscript').textContent = '';
  document.getElementById('voiceDailyPrompt').style.display = 'none';

  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = LANG_CODES[langIndex];
  langIndex = (langIndex + 1) % LANG_CODES.length;

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    document.getElementById('voiceTranscript').textContent = final || interim;
    if (final) processVoiceCommand(final.toLowerCase().trim());
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
  voiceIsListening = false;
  if (recognition) { try { recognition.stop(); } catch (e) { } recognition = null; }
  document.getElementById('voiceOverlay').classList.remove('open');
  document.getElementById('voiceFab').classList.remove('listening');
  document.getElementById('voiceFabIcon').className = 'fas fa-microphone';
  pendingVoiceTimerData = null;
  document.getElementById('voiceDailyPrompt').style.display = 'none';
}

/* ─────────────────────────────────────────────
   VOICE COMMAND PARSER
───────────────────────────────────────────── */
function processVoiceCommand(text) {
  const norm = normalize(text);
  document.getElementById('voiceStatus').textContent = 'Processing: "' + text + '"';

  // 1. Try timer command (has time references)
  const timerData = parseVoiceTimer(norm);
  if (timerData) {
    // Ask "mark as daily?"
    pendingVoiceTimerData = timerData;
    document.getElementById('voiceStatus').textContent = `⏱ Timer: ${getAlias(timerData.relay)} ${timerData.action} ${timerData.startTime}${timerData.endTime ? ' → ' + timerData.endTime : ''}`;
    document.getElementById('voiceDailyPrompt').style.display = 'block';
    return;
  }

  // 2. Try relay ON/OFF command
  const relayCmd = parseRelayCommand(norm);
  if (relayCmd) {
    document.getElementById('voiceStatus').textContent = `✅ ${getAlias(relayCmd.relay)} → ${relayCmd.action}`;
    toggleRelay(relayCmd.relay, relayCmd.action === 'ON', null);
    setTimeout(stopVoiceCommand, 1500);
    return;
  }

  document.getElementById('voiceStatus').textContent = '❓ Command not understood. Try: "fan on karo" or "light band karo"';
  setTimeout(stopVoiceCommand, 3000);
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
  const onWords = ['on', 'chalu', 'chalv', 'chalo', 'jalao', 'jala', 'lav', 'laga', 'shuru', 'start', 'open', '켜'];
  const offWords = ['off', 'band', 'bandh', 'stop', 'bujhao', 'bujha', 'close', 'बंद'];

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
  const onWords = ['on ', 'on karo', 'chalu', 'jalao', 'lav', 'shuru', 'start', 'chalo', 'laga', 'open'];
  const offWords = ['off', 'band', 'bandh', 'stop', 'bujhao', 'close'];
  const isOn = onWords.some(w => norm.includes(w));
  const isOff = offWords.some(w => norm.includes(w));
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
