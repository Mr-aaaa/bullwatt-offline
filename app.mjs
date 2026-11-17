import { Device } from './bluetooth.mjs';
import { LatestPower, fallbackRange, normalizePower } from './control.mjs';
import { sample, summary, csv, tcx, validateBackup, compactReport, heartZone } from './session.mjs';
import { openStore, dbRequest, restore } from './storage.mjs';
import { drawCharts } from './charts.mjs';
import { updateApplication } from './update.mjs';

const el = id => document.getElementById(id);
const text = (id, value) => { el(id).textContent = value; };
const show = (id, value) => { text(id, value); el(id).hidden = !value; };
const display = value => value == null ? '—' : Math.round(value).toLocaleString('zh-CN');
const date = value => new Date(value).toLocaleString('zh-CN');
const clock = seconds => {
  const total = Math.floor(seconds);
  return [Math.floor(total / 60), total % 60].map(value => String(value).padStart(2, '0')).join(':');
};
const iso = () => new Date().toISOString();

const database = openStore();
const unsaved = new Map();
let writes = Promise.resolve();
let ride = null;
let selected = null;
let pendingRecovery = null;
let requested = 50;
let accepted = null;
let lastTick = 0;
let lastSave = 0;
let transition = false;
let checkingRecovery = true;
let operation = 0;
let wakeLock;
let wakePending = false;
let maxHeartRate = null;
try {
  const value = Number(localStorage.getItem('bullwatt-max-heart-rate'));
  if (Number.isInteger(value) && value >= 60 && value <= 250) maxHeartRate = value;
} catch {
  // The dashboard still works when browser storage is unavailable.
}
const zoneLabels = {
  easy: '轻松', moderate: '燃脂', aerobic: '有氧', high: '无氧',
};

const readings = {};
const names = { trainer: '', heart: '' };
const connectedLabels = { trainer: '骑行台', heart: '心率设备' };
const connectionBusy = { trainer: false, heart: false };
const remember = (field, value) => { readings[field] = { value, at: performance.now() }; };
function liveValue(field) {
  const reading = readings[field];
  return reading && performance.now() - reading.at < 5000 ? reading.value : null;
}

const trainer = new Device('trainer', values => {
  for (const field of ['power', 'cadence', 'speed']) {
    if (Number.isFinite(values[field])) remember(field, values[field]);
  }
}, () => disconnected('trainer'));
const heart = new Device('heart', values => {
  remember('heartRate', values.heartRate > 0 ? values.heartRate : null);
}, () => disconnected('heart'));
const devices = { trainer, heart };
const powerQueue = new LatestPower(async watts => {
  await trainer.setPower(watts);
  accepted = watts;
  text('command', '设备已接受 ' + watts + ' W');
});

function range() {
  return trainer.connected ? trainer.range : fallbackRange;
}
function updateButtons() {
  const running = ride?.status === 'running';
  el('start').disabled = checkingRecovery || transition || !!pendingRecovery || (!running && !trainer.connected);
  text('start', running ? '暂停训练' : ride ? '继续训练' : '开始训练');
  text('connection-summary', trainer.connected ? (heart.connected ? '骑行台 · 心率已连接' : '骑行台已连接') : '连接设备');
  el('connection-summary').dataset.connected = String(!!trainer.connected);
  el('finish').disabled = !ride || transition;
  el('lower').disabled = !running || transition || !trainer.connected;
  el('app-update').disabled = !!ride || transition || checkingRecovery || !!pendingRecovery;
  for (const key of Object.keys(devices)) {
    el(key).disabled = connectionBusy[key] || (key === 'trainer' && transition);
    text(key, (devices[key].connected ? '断开' : '连接') + connectedLabels[key]);
  }
}

function updatePowerDisplay() {
  el('watts').value = requested;
  const { min, max, step } = range();
  const note = trainer.rangeVerified && trainer.connected ? '设备范围' : '应用限值（未读取到设备范围）';
  text('range', note + ' ' + min + '–' + max + ' W · 增量 ' + step + ' W');
  for (const button of el('presets').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.watts) === requested));
  }
}

async function connect(key) {
  const device = devices[key];
  if (device.connected) {
    if (key === 'trainer' && ride?.status === 'running') await pause('断开骑行台');
    device.cleanup();
    return;
  }
  connectionBusy[key] = true;
  text(key + '-state', '正在连接…');
  updateButtons();
  try {
    names[key] = await device.connect();
    if (key === 'trainer') {
      accepted = null;
      requested = normalizePower(requested, range());
      updatePowerDisplay();
    }
    if (ride) {
      ride[key === 'trainer' ? 'trainerName' : 'heartRateDeviceName'] = names[key];
      save(ride);
    }
    text(key + '-state', names[key] + ' · 等待数据');
    show('message', '');
  } catch (error) {
    text(key + '-state', error.name === 'NotFoundError' ? '未选择设备' : '连接失败 · ' + error.message);
  } finally {
    connectionBusy[key] = false;
    updateButtons();
  }
}

function disconnected(key) {
  names[key] = '';
  text(key + '-state', '已断开');
  if (key === 'trainer') {
    operation++;
    powerQueue.cancel();
    accepted = null;
    delete readings.power;
    delete readings.cadence;
    delete readings.speed;
    if (ride?.status === 'running') {
      markPaused('骑行台已断开');
      save(ride);
    }
    text('command', '骑行台已断开，当前阻力未知');
    updatePowerDisplay();
  } else {
    delete readings.heartRate;
  }
  updateButtons();
}

function save(record) {
  const snapshot = structuredClone(record);
  lastSave = performance.now();
  const next = writes.then(async () => {
    try {
      await dbRequest(database, 'readwrite', store => store.put(snapshot));
      unsaved.delete(snapshot.id);
      text('save-state', '已保存到此浏览器 · ' + new Date().toLocaleTimeString('zh-CN'));
    } catch (error) {
      unsaved.set(snapshot.id, snapshot);
      text('save-state', '保存失败，请导出备份 · ' + error.message);
    }
    el('rescue').hidden = !unsaved.size;
  });
  writes = next.catch(console.error);
  return next;
}

function markPaused(reason) {
  if (ride?.status !== 'running') return;
  ride.status = 'paused';
  ride.events.push({ timestamp: iso(), reason });
  releaseScreen();
}

async function holdScreen() {
  if (wakePending || wakeLock || ride?.status !== 'running' || document.hidden) return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (ride?.status !== 'running' || document.hidden) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (ride?.status === 'running' && !document.hidden) show('message', '屏幕常亮已关闭，请保持页面亮屏');
    }, { once: true });
  } catch {
    if (ride?.status === 'running') show('message', '屏幕常亮不可用，请保持页面亮屏');
  } finally {
    wakePending = false;
  }
}

function releaseScreen() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(console.warn);
}

function tick(now = performance.now()) {
  if (ride?.status !== 'running') return true;
  const elapsed = (now - lastTick) / 1000;
  if (elapsed <= 0) return true;
  if (!sample(ride, Date.now(), elapsed, {
    power: liveValue('power'), cadence: liveValue('cadence'), heartRate: liveValue('heartRate'),
    requestedPower: requested, acceptedPower: accepted,
  })) return false;
  lastTick = now;
  return true;
}

async function reducePower() {
  if (!trainer.connected) {
    text('command', '骑行台已断开，当前阻力未知');
    return;
  }
  const low = lowerTarget();
  text('command', '正在降至 ' + low + ' W…');
  try {
    await powerQueue.set(low);
  } catch (error) {
    text('command', error.message + '，当前阻力未知。请重新连接骑行台');
    trainer.cleanup(false);
    names.trainer = '';
    accepted = null;
    delete readings.power;
    delete readings.cadence;
    delete readings.speed;
    text('trainer-state', '请重新连接');
    updatePowerDisplay();
  }
}

function lowerTarget() {
  return normalizePower(Math.min(30, requested, accepted ?? requested), range());
}

async function pause(reason) {
  if (ride?.status !== 'running') return;
  transition = true;
  operation++;
  if (reason !== '计时中断') tick();
  markPaused(reason);
  powerQueue.cancel();
  const stored = save(ride);
  updateButtons();
  try {
    await Promise.all([stored, reducePower()]);
  } finally {
    transition = false;
    renderTraining();
    updateButtons();
  }
}

async function start() {
  if (checkingRecovery || transition || pendingRecovery || !trainer.connected || document.hidden) return;
  transition = true;
  const token = ++operation;
  updateButtons();
  let attemptedLoad = false;
  const check = () => {
    if (operation !== token || document.hidden || !trainer.connected) throw new Error('开始已取消');
  };
  try {
    text('command', '正在获取骑行台控制权…');
    await trainer.requestControl();
    check();
    const target = requested;
    attemptedLoad = true;
    await powerQueue.set(target);
    check();
    if (!ride) {
      ride = {
        id: crypto.randomUUID(), schemaVersion: 1, name: '骑行训练',
        startedAt: iso(), endedAt: null, status: 'running', activeSeconds: 0,
        durationMode: 'positive-power', recordedSeconds: 0,
        trainerName: names.trainer, heartRateDeviceName: names.heart || null,
        samples: [], events: [],
      };
    } else {
      ride.status = 'running';
      ride.events.push({ timestamp: iso(), reason: '继续训练' });
    }
    lastTick = performance.now();
    save(ride);
    show('message', '');
    holdScreen();
  } catch (error) {
    powerQueue.cancel();
    if (attemptedLoad && trainer.connected && operation !== token) await reducePower();
    else {
      text('command', error.message + '。请检查设备连接');
      if (trainer.point?.closed) trainer.cleanup();
    }
  } finally {
    transition = false;
    updateButtons();
  }
}

async function finish() {
  if (!ride || transition) return;
  transition = true;
  operation++;
  const running = ride.status === 'running';
  if (running) tick();
  const completed = ride;
  completed.status = 'completed';
  completed.endedAt = iso();
  ride = null;
  releaseScreen();
  powerQueue.cancel();
  const stored = save(completed);
  updateButtons();
  try {
    await Promise.all([stored, running ? reducePower() : Promise.resolve()]);
    await openPage('history', completed.id);
  } finally {
    transition = false;
    updateButtons();
  }
}

function applyPower(value) {
  if (transition) return;
  try {
    requested = normalizePower(value, range());
    updatePowerDisplay();
    show('message', '');
  } catch (error) {
    show('message', error.message);
    return;
  }
  if (ride?.status !== 'running') {
    text('command', '目标已设置，开始或继续训练后下发');
    return;
  }
  text('command', '正在发送 ' + requested + ' W…');
  const liveOperation = operation;
  powerQueue.set(requested).catch(error => {
    if (liveOperation !== operation) return;
    text('command', error.message + '，当前阻力未知。请重新连接骑行台');
    trainer.cleanup();
    show('message', error.message + '，训练已暂停');
  });
}

function renderTraining() {
  const power = liveValue('power');
  const cadence = liveValue('cadence');
  const hr = liveValue('heartRate');
  text('power', display(power));
  text('cadence', display(cadence));
  text('hr', display(hr));
  const speed = liveValue('speed');
  text('speed', speed == null ? '—' : speed.toFixed(1));
  renderHeartZone(hr);
  text('duration', clock(ride?.activeSeconds ?? 0));
  text('average', display(ride ? summary(ride).power.mean : null));
  text('cadence-average', '平均 ' + display(ride ? summary(ride).cadence.mean : null) + ' rpm');
  if (trainer.connected) text('trainer-state', names.trainer + (power == null ? ' · 暂无功率数据' : ' · 数据正常'));
  if (heart.connected) text('heart-state', names.heart + (hr == null ? ' · 暂无心率数据' : ' · 数据正常'));
  if (!el('training').hidden) {
    const cutoff = Date.now() - 120000;
    const points = (ride?.samples ?? []).slice(-125).filter(point => Date.parse(point.timestamp) >= cutoff);
    drawCharts(el('live'), points);
  }
}

function renderHeartZone(hr) {
  const card = el('heart-card');
  const zone = heartZone(hr, maxHeartRate);
  let label = zoneLabels[zone] ?? (hr == null ? '等待心率' : '设置最大心率');
  if (zone) {
    const limits = { easy: [0, .5], moderate: [.5, .7], aerobic: [.7, .85], high: [.85, null] }[zone];
    const low = Math.ceil(maxHeartRate * limits[0]);
    label += limits[1] === null ? ' · ≥' + low + ' bpm' : ' · ' + low + '–' + (Math.ceil(maxHeartRate * limits[1]) - 1) + ' bpm';
  }
  card.dataset.zone = zone ?? 'none';
  if (el('heart-zone').textContent !== label) text('heart-zone', label);
  if (zone) card.style.setProperty('--beat', (60 / Math.max(40, Math.min(220, hr))).toFixed(3) + 's');
  else card.style.removeProperty('--beat');
  const meter = el('zone-meter');
  meter.dataset.ready = String(!!zone);
  const position = zone ? Math.max(0, Math.min(100, (hr / maxHeartRate - .4) / .6 * 100)) : 0;
  meter.style.setProperty('--position', position.toFixed(1) + '%');
  for (const part of meter.querySelectorAll('[data-band]')) {
    part.classList.toggle('current', zone === part.dataset.band);
    const band = part.dataset.band;
    const labels = { easy: '轻松 <50%', moderate: '燃脂 50–70%', aerobic: '有氧 70–85%', high: '无氧 ≥85%' };
    part.title = labels[band] + ' 最大心率';
  }
}

let historyRevision = 0;
async function allRides() {
  await writes;
  const stored = await dbRequest(database, 'readonly', store => store.getAll()).catch(error => {
    if (!unsaved.size && !ride) throw error;
    return [];
  });
  const merged = new Map(stored.map(item => [item.id, item]));
  for (const [id, item] of unsaved) merged.set(id, item);
  if (ride) merged.set(ride.id, structuredClone(ride));
  return [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function selectReport(record) {
  selected = record;
  const stats = summary(record);
  text('report-name', record.name + ' · ' + date(record.startedAt));
  const durationLabel = record.durationMode === 'positive-power' ? '输出功率时长 ' : '记录时长 ';
  text('report-summary', durationLabel + clock(record.activeSeconds) + ' · 功率 平均 ' + display(stats.power.mean) +
    ' / 最大 ' + display(stats.power.max) + ' W · 心率 平均 ' + display(stats.heartRate.mean) +
    ' / 最大 ' + display(stats.heartRate.max) + ' bpm');
  drawCharts(el('report-chart'), record.samples);
  el('report-events').replaceChildren(...record.events.map(event => {
    const item = document.createElement('li');
    item.textContent = date(event.timestamp) + ' · ' + event.reason;
    return item;
  }));
  el('report').hidden = false;
}

async function loadHistory(id) {
  const revision = ++historyRevision;
  el('report').hidden = true;
  selected = null;
  try {
    const records = (await allRides()).filter(item => ['completed', 'interrupted'].includes(item.status));
    if (revision !== historyRevision) return;
    el('rides').replaceChildren(...records.map(record => {
      const button = document.createElement('button');
      const stats = summary(record);
      button.textContent = date(record.startedAt) + ' · ' + clock(record.activeSeconds) +
        ' · ' + display(stats.power.mean) + ' W · ' + display(stats.heartRate.mean) + ' bpm' +
        (record.status === 'interrupted' ? ' · 中断' : '') + (unsaved.has(record.id) ? ' · 未保存' : '');
      button.onclick = () => selectReport(record);
      return button;
    }));
    text('history-status', records.length ? records.length + ' 次训练' : '完成一场训练后，记录会出现在这里。');
    const record = records.find(item => item.id === id);
    if (record) selectReport(record);
  } catch (error) {
    text('history-status', '无法读取记录 · ' + error.message);
  }
}

async function openPage(page, id) {
  for (const key of ['training', 'history', 'settings']) el(key).hidden = key !== page;
  for (const button of document.querySelectorAll('[data-page]')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (page === 'history') await loadHistory(id);
  if (page === 'training') renderTraining();
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function backup(records) {
  download('bullwatt-备份.json', JSON.stringify({ version: 1, sessions: records }), 'application/json');
}

async function recover(asInterrupted) {
  if (!pendingRecovery || transition) return;
  transition = true;
  const record = pendingRecovery;
  pendingRecovery = null;
  el('recovery').hidden = true;
  record.status = asInterrupted ? 'interrupted' : 'paused';
  record.endedAt = asInterrupted ? (record.samples.at(-1)?.timestamp ?? record.startedAt) : null;
  record.events.push({ timestamp: iso(), reason: asInterrupted ? '保存为中断记录' : '恢复记录，等待继续' });
  if (!asInterrupted) {
    ride = record;
    const previousTarget = record.samples.at(-1)?.requestedPower;
    if (previousTarget != null) requested = normalizePower(previousTarget, range());
    updatePowerDisplay();
  }
  await save(record);
  transition = false;
  updateButtons();
  if (asInterrupted) await openPage('history', record.id);
}

async function scanRecovery() {
  checkingRecovery = true;
  updateButtons();
  try {
    const records = await allRides();
    const unfinished = records.filter(item => ['running', 'paused'].includes(item.status));
    pendingRecovery = unfinished.shift() ?? null;
    for (const record of unfinished) {
      record.status = 'interrupted';
      record.endedAt = record.samples.at(-1)?.timestamp ?? record.startedAt;
      save(record);
    }
    el('recovery').hidden = !pendingRecovery;
  } catch (error) {
    text('save-state', '存储不可用 · ' + error.message);
  }
  checkingRecovery = false;
  updateButtons();
}

let presets = [80, 120, 160, 200];
try {
  const stored = JSON.parse(localStorage.getItem('bullwatt-presets'));
  if (Array.isArray(stored) && stored.length && stored.length <= 4 && stored.every(value =>
    Number.isInteger(value) && value >= 0 && value <= 32767)) presets = stored;
} catch (error) {
  console.info('Preset storage unavailable', error);
}

function renderPresets() {
  el('preset-input').value = presets.join(', ');
  el('presets').replaceChildren(...presets.map(value => {
    const button = document.createElement('button');
    button.textContent = value + ' W';
    button.dataset.watts = value;
    button.setAttribute('aria-pressed', String(value === requested));
    button.onclick = () => applyPower(value);
    return button;
  }));
}

el('trainer').onclick = () => connect('trainer');
el('connection-summary').onclick = () => {
  const options = el('device-options');
  options.open = !options.open;
  if (options.open) options.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
el('heart').onclick = () => connect('heart');
el('start').onclick = () => ride?.status === 'running' ? pause('手动暂停') : start();
el('finish').onclick = finish;
el('lower').onclick = () => applyPower(lowerTarget());
el('power-form').onsubmit = event => { event.preventDefault(); applyPower(el('watts').value); };
el('step').onchange = () => {
  el('less').setAttribute('aria-label', '减少 ' + el('step').value + ' W');
  el('more').setAttribute('aria-label', '增加 ' + el('step').value + ' W');
};
function adjust(direction) {
  const delta = Math.max(Number(el('step').value), range().step);
  applyPower(Math.max(range().min, requested + direction * delta));
}
el('less').onclick = () => adjust(-1);
el('more').onclick = () => adjust(1);
el('recover').onclick = () => recover(false);
el('interrupt').onclick = () => recover(true);
el('rescue').onclick = () => backup([...unsaved.values()]);
for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => openPage(button.dataset.page);
el('csv').onclick = () => { if (selected) download('bullwatt-' + selected.startedAt.slice(0, 10) + '.csv', csv(selected), 'text/csv'); };
el('tcx').onclick = () => { if (selected) download('bullwatt-' + selected.startedAt.slice(0, 10) + '.tcx', tcx(selected), 'application/xml'); };
el('compact').onclick = () => {
  if (!selected) return;
  const stamp = selected.startedAt.slice(0, 19).replaceAll(':', '-');
  download('bullwatt-summary-' + stamp + '.json', JSON.stringify(compactReport(selected)), 'application/json');
};
el('delete').onclick = async () => {
  const id = selected?.id;
  if (!id || !confirm('删除这条训练记录？')) return;
  try {
    await writes;
    await dbRequest(database, 'readwrite', store => store.delete(id));
    unsaved.delete(id);
    el('rescue').hidden = !unsaved.size;
    await loadHistory();
  } catch (error) {
    text('history-status', '删除失败 · ' + error.message);
  }
};
el('backup').onclick = async () => {
  try {
    backup(await allRides());
  } catch (error) {
    text('settings-status', '备份失败 · ' + error.message);
  }
};
el('import').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (checkingRecovery || transition || ride || pendingRecovery) throw new Error('请先结束或保存当前训练');
    if (file.size > 64 * 1024 * 1024) throw new Error('备份文件超过 64 MB');
    const records = validateBackup(JSON.parse(await file.text()));
    if (checkingRecovery || transition || ride || pendingRecovery) throw new Error('请先结束或保存当前训练');
    checkingRecovery = true;
    updateButtons();
    try {
      const count = await restore(database, records);
      text('settings-status', '已导入 ' + count + ' 条记录，跳过 ' + (records.length - count) + ' 条重复记录');
      await scanRecovery();
    } finally {
      checkingRecovery = false;
      updateButtons();
    }
  } catch (error) {
    text('settings-status', '导入失败 · ' + error.message);
  } finally {
    event.target.value = '';
  }
};
el('preset-form').onsubmit = event => {
  event.preventDefault();
  const parts = el('preset-input').value.split(/[,，]/);
  const values = parts.map(Number);
  if (values.length > 4 || parts.some(part => !/^\d+$/.test(part.trim())) ||
      values.some(value => !Number.isInteger(value) || value > 32767)) {
    text('settings-status', '请输入 1–4 个非负整数瓦数');
    return;
  }
  presets = values;
  renderPresets();
  try {
    localStorage.setItem('bullwatt-presets', JSON.stringify(presets));
    text('settings-status', '快捷功率已保存');
  } catch {
    text('settings-status', '浏览器无法保存设置，本次打开期间仍可使用');
  }
};

el('max-hr').value = maxHeartRate ?? '';
el('heart-zone-form').onsubmit = event => {
  event.preventDefault();
  const input = el('max-hr');
  if (!input.reportValidity()) return;
  maxHeartRate = input.value === '' ? null : input.valueAsNumber;
  renderHeartZone(liveValue('heartRate'));
  try {
    if (maxHeartRate === null) localStorage.removeItem('bullwatt-max-heart-rate');
    else localStorage.setItem('bullwatt-max-heart-rate', String(maxHeartRate));
    text('heart-zone-status', maxHeartRate ? '最大心率已保存' : '已关闭区间提示');
  } catch {
    text('heart-zone-status', '浏览器无法保存设置，本次打开期间仍可使用');
  }
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (ride?.status === 'running') pause('页面切到后台');
  else if (transition) operation++;
});
el('app-update').onclick = async () => {
  if (ride || transition || pendingRecovery || checkingRecovery) return;
  if (!confirm('已结束训练并关闭其他 BullWatt 页面？现在更新应用。')) return;
  transition = true;
  updateButtons();
  text('update-status', '正在检查并下载新版…');
  try {
    await updateApplication();
    location.reload();
  } catch (error) {
    text('update-status', '更新失败 · ' + error.message);
    transition = false;
    updateButtons();
  }
};
setInterval(() => {
  const now = performance.now();
  if (ride?.status === 'running') {
    if (!tick(now)) pause('计时中断');
    else if (now - lastSave >= 5000) save(ride);
  }
  renderTraining();
}, 1000);

async function prepareOffline() {
  if (!('serviceWorker' in navigator)) {
    text('offline', '离线缓存需 HTTPS');
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const check = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        text('offline', '新版已缓存，结束后关闭页面再打开');
      } else if (registration.active?.state === 'activated' || navigator.serviceWorker.controller) {
        text('offline', '离线已就绪');
      } else if (!registration.installing && !registration.waiting) {
        text('offline', '离线缓存未完成，请重新加载');
      }
    };
    const watch = () => registration.installing?.addEventListener('statechange', event => {
      if (event.target.state === 'redundant' && !registration.active) text('offline', '离线缓存失败，请重新加载');
      else check();
    });
    registration.addEventListener('updatefound', watch);
    navigator.serviceWorker.addEventListener('controllerchange', check);
    watch();
    navigator.serviceWorker.ready.then(check);
    check();
  } catch (error) {
    text('offline', navigator.serviceWorker.controller ? '离线已就绪' : '离线缓存不可用');
    console.warn(error);
  }
}

renderPresets();
renderTraining();
prepareOffline();
scanRecovery();
