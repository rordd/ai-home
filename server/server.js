const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Timer management for washer/dishwasher
const timers = {};

// In-memory storage for notifications and TV messages
let notifications = [];
let tvMessage = null;

const DATA_DIR = path.join(__dirname, 'data');
const FRIDGE_PATH = path.join(DATA_DIR, 'fridge.json');
const APPLIANCES_PATH = path.join(DATA_DIR, 'appliances.json');

app.use(cors());
app.use(express.json());

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper: read JSON file
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// Helper: write JSON file
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Helper: add notification
function addNotification(message, type = 'info') {
  const validTypes = ['info', 'success', 'warning', 'alert'];
  const nType = validTypes.includes(type) ? type : 'info';
  notifications.push({ id: Date.now(), message, type: nType, time: new Date().toISOString() });
  if (notifications.length > 50) notifications = notifications.slice(-50);
}

// Helper: start appliance timer (washer/dishwasher)
function startApplianceTimer(room, device, displayMin) {
  const timerKey = `${room}/${device}`;
  // Clear existing timer
  if (timers[timerKey]) clearTimeout(timers[timerKey]);
  // Real time = display time / 10
  const realMs = (displayMin / 10) * 60 * 1000;
  timers[timerKey] = setTimeout(() => {
    const data = readJSON(APPLIANCES_PATH);
    if (data.rooms?.[room]?.[device]) {
      data.rooms[room][device].status = 'done';
      data.rooms[room][device].remainingMin = 0;
      writeJSON(APPLIANCES_PATH, data);
      const name = data.rooms[room][device].name || device;
      addNotification(`${name} 작동 완료!`, 'success');
    }
    delete timers[timerKey];
  }, realMs);
}

// ============================================================
// POST /api/chat — call picoclaw in WSL
// ============================================================
app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const escaped = message.replace(/'/g, "'\\''").replace(/"/g, '\\"');
    const stdout = execSync(
      `wsl -e bash -c "echo '${escaped}' | HOME=/home/rordd/.picoclaw-home /home/rordd/.local/bin/picoclaw agent"`,
      { timeout: 30000, encoding: 'utf-8' }
    );
    let reply = stdout.trim()
      .replace(/🦞\s*Interactive mode.*?\n/g, '')
      .replace(/\nGoodbye!$/g, '')
      .replace(/^🦞\s*/gm, '')
      .replace(/^\n+|\n+$/g, '')
      .trim();
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'picoclaw failed', detail: err.stderr || err.message });
  }
});

// ============================================================
// Fridge endpoints
// ============================================================
app.get('/api/fridge', (req, res) => {
  res.json(readJSON(FRIDGE_PATH));
});

app.post('/api/fridge/add', (req, res) => {
  const { name, quantity, expiry, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const data = readJSON(FRIDGE_PATH);
  if (!data.items) data.items = [];
  const maxId = data.items.reduce((m, i) => Math.max(m, i.id || 0), 0);
  const newItem = { id: maxId + 1, name, quantity: quantity || '1개', expiry: expiry || null, category: category || '기타' };
  data.items.push(newItem);
  data.lastUpdated = new Date().toISOString();
  writeJSON(FRIDGE_PATH, data);
  res.json(newItem);
});

app.post('/api/fridge/remove', (req, res) => {
  const { id } = req.body;
  if (id === undefined) return res.status(400).json({ error: 'id is required' });

  const data = readJSON(FRIDGE_PATH);
  if (!data.items) return res.status(404).json({ error: 'no items' });
  const before = data.items.length;
  data.items = data.items.filter(item => item.id !== id);
  if (data.items.length === before) return res.status(404).json({ error: 'item not found' });

  data.lastUpdated = new Date().toISOString();
  writeJSON(FRIDGE_PATH, data);
  res.json({ success: true });
});

// ============================================================
// Appliances endpoints
// ============================================================

// GET /api/appliances — return rooms structure
app.get('/api/appliances', (req, res) => {
  res.json(readJSON(APPLIANCES_PATH));
});

// POST /api/appliances/goout — 외출모드
app.post('/api/appliances/goout', (req, res) => {
  const data = readJSON(APPLIANCES_PATH);
  const rooms = data.rooms || {};

  for (const room of Object.values(rooms)) {
    // 조명 끄기
    if (room.light) { room.light.status = 'off'; room.light.brightness = 0; }
    // TV 끄기
    if (room.tv) { room.tv.status = 'off'; }
    // 에어컨 끄기
    if (room.aircon) { room.aircon.status = 'off'; }
    // 선풍기 끄기
    if (room.fan) { room.fan.status = 'off'; }
    // 공기청정기 끄기
    if (room.airpurifier) { room.airpurifier.status = 'off'; }
    // 도어락 잠금
    if (room.doorlock) { room.doorlock.status = 'locked'; }
  }

  writeJSON(APPLIANCES_PATH, data);
  addNotification('외출모드가 실행되었습니다. 모든 조명/가전이 꺼지고 도어락이 잠겼습니다.', 'info');
  res.json({ success: true, message: '외출모드 실행 완료' });
});

// POST /api/appliances/comehome — 귀가모드
app.post('/api/appliances/comehome', (req, res) => {
  const data = readJSON(APPLIANCES_PATH);
  const rooms = data.rooms || {};

  // 거실 조명 켜기
  if (rooms['거실']?.light) { rooms['거실'].light.status = 'on'; rooms['거실'].light.brightness = 80; }
  // 현관 도어락 열기
  if (rooms['현관']?.doorlock) { rooms['현관'].doorlock.status = 'unlocked'; }
  // 거실 공기청정기 자동
  if (rooms['거실']?.airpurifier) { rooms['거실'].airpurifier.status = 'auto'; }

  writeJSON(APPLIANCES_PATH, data);
  addNotification('귀가모드가 실행되었습니다. 거실 조명, 공기청정기가 켜지고 도어락이 열렸습니다.', 'info');
  res.json({ success: true, message: '귀가모드 실행 완료' });
});

// POST /api/appliances/:room/:device — control a device in a room
app.post('/api/appliances/:room/:device', (req, res) => {
  const { room, device } = req.params;
  const body = req.body;
  const { action } = body;

  const data = readJSON(APPLIANCES_PATH);
  if (!data.rooms?.[room]) return res.status(404).json({ error: `방 '${room}'을(를) 찾을 수 없습니다` });
  if (!data.rooms[room][device]) return res.status(404).json({ error: `'${room}'에 '${device}' 기기가 없습니다` });

  const dev = data.rooms[room][device];

  switch (device) {
    case 'light':
      if (action === 'on') { dev.status = 'on'; dev.brightness = body.brightness ?? dev.brightness ?? 80; }
      else if (action === 'off') { dev.status = 'off'; dev.brightness = 0; }
      if (body.brightness !== undefined && dev.status === 'on') dev.brightness = body.brightness;
      break;

    case 'aircon':
      if (action === 'on') dev.status = 'on';
      else if (action === 'off') dev.status = 'off';
      if (body.targetTemp !== undefined) dev.targetTemp = body.targetTemp;
      if (body.mode !== undefined) dev.mode = body.mode;
      break;

    case 'tv':
      if (action === 'on') dev.status = 'on';
      else if (action === 'off') dev.status = 'off';
      if (body.volume !== undefined) dev.volume = body.volume;
      if (body.input !== undefined) dev.input = body.input;
      break;

    case 'washer': {
      if (action === 'start') {
        const course = body.course || '표준';
        const courseMin = { '표준': 40, '급속': 20, '울': 50 };
        const displayMin = courseMin[course] || 40;
        dev.status = 'running';
        dev.course = course;
        dev.remainingMin = displayMin;
        startApplianceTimer(room, device, displayMin);
      } else if (action === 'stop') {
        dev.status = 'idle';
        dev.remainingMin = 0;
        dev.course = null;
        const timerKey = `${room}/${device}`;
        if (timers[timerKey]) { clearTimeout(timers[timerKey]); delete timers[timerKey]; }
      }
      break;
    }

    case 'dishwasher': {
      if (action === 'start') {
        const course = body.course || '표준';
        const courseMin = { '표준': 60, '강력': 90 };
        const displayMin = courseMin[course] || 60;
        dev.status = 'running';
        dev.course = course;
        dev.remainingMin = displayMin;
        startApplianceTimer(room, device, displayMin);
      } else if (action === 'stop') {
        dev.status = 'idle';
        dev.remainingMin = 0;
        dev.course = null;
        const timerKey = `${room}/${device}`;
        if (timers[timerKey]) { clearTimeout(timers[timerKey]); delete timers[timerKey]; }
      }
      break;
    }

    case 'vacuum':
      if (action === 'start') { dev.status = 'cleaning'; }
      else if (action === 'stop') { dev.status = 'idle'; dev.lastCleaned = new Date().toISOString(); }
      break;

    case 'doorlock':
      if (action === 'lock') dev.status = 'locked';
      else if (action === 'unlock') dev.status = 'unlocked';
      break;

    case 'fan':
      if (action === 'on') dev.status = 'on';
      else if (action === 'off') dev.status = 'off';
      break;

    case 'airpurifier':
      if (action === 'on') dev.status = 'on';
      else if (action === 'off') dev.status = 'off';
      else if (action === 'auto') dev.status = 'auto';
      break;

    default:
      // Generic on/off for unknown devices
      if (action === 'on' || action === 'off') dev.status = action;
      break;
  }

  writeJSON(APPLIANCES_PATH, data);
  res.json(dev);
});

// Legacy: POST /api/appliances/:device (keep for backward compatibility)
app.post('/api/appliances/:device', (req, res) => {
  const { device } = req.params;
  const { state, targetTemp, mode, brightness } = req.body;

  const data = readJSON(APPLIANCES_PATH);

  // Search all rooms for the device
  let found = null;
  let foundRoom = null;
  if (data.rooms) {
    for (const [roomName, room] of Object.entries(data.rooms)) {
      if (room[device]) { found = room[device]; foundRoom = roomName; break; }
    }
  }
  if (!found) return res.status(404).json({ error: 'device not found' });

  if (state !== undefined) found.status = state === 'on' ? 'on' : (state === 'off' ? 'off' : state);
  if (targetTemp !== undefined) found.targetTemp = targetTemp;
  if (mode !== undefined) found.mode = mode;
  if (brightness !== undefined) found.brightness = brightness;

  writeJSON(APPLIANCES_PATH, data);
  res.json(found);
});

// ============================================================
// Notification & TV Message endpoints
// ============================================================

app.post('/api/notify', (req, res) => {
  const { message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  addNotification(message, type);
  res.json({ success: true });
});

app.get('/api/notifications', (req, res) => {
  const result = [...notifications];
  notifications = [];
  res.json(result);
});

app.post('/api/tv/message', (req, res) => {
  const { text, duration } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const dur = Number(duration) || 10;
  tvMessage = { text, duration: dur, expiresAt: Date.now() + dur * 1000 };
  res.json({ success: true });
});

app.get('/api/tv/message', (req, res) => {
  if (tvMessage && Date.now() > tvMessage.expiresAt) tvMessage = null;
  res.json(tvMessage || { text: null });
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐦 AI홈 서버 running on http://0.0.0.0:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   📱 네트워크 접속: http://${net.address}:${PORT}`);
      }
    }
  }
});
