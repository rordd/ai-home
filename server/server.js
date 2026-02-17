const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, '..', 'data');
const FRIDGE_PATH = path.join(DATA_DIR, 'fridge.json');
const APPLIANCES_PATH = path.join(DATA_DIR, 'appliances.json');

app.use(cors());
app.use(express.json());

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Helper: read JSON file
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// Helper: write JSON file
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// POST /api/chat
app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const escaped = message.replace(/'/g, "'\\''");
    const stdout = execSync(
      `echo '${escaped}' | HOME=/home/rordd/.picoclaw-home picoclaw agent`,
      { timeout: 30000, encoding: 'utf-8' }
    );
    // Clean up picoclaw output: remove interactive mode header, emoji prefix, goodbye
    let reply = stdout.trim()
      .replace(/🦞\s*Interactive mode.*?\n/g, '')
      .replace(/\nGoodbye!$/g, '')
      .replace(/^🦞\s*/gm, '')
      .replace(/^\n+|\n+$/g, '')
      .trim();
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'picoclaw failed', detail: err.message });
  }
});

// GET /api/fridge
app.get('/api/fridge', (req, res) => {
  res.json(readJSON(FRIDGE_PATH));
});

// POST /api/fridge/add
app.post('/api/fridge/add', (req, res) => {
  const { name, quantity, expiry, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const items = readJSON(FRIDGE_PATH);
  const newItem = {
    id: Date.now().toString(),
    name,
    quantity: quantity || 1,
    expiry: expiry || null,
    category: category || 'etc'
  };
  items.push(newItem);
  writeJSON(FRIDGE_PATH, items);
  res.json(newItem);
});

// POST /api/fridge/remove
app.post('/api/fridge/remove', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  let items = readJSON(FRIDGE_PATH);
  const before = items.length;
  items = items.filter(item => item.id !== id);
  if (items.length === before) return res.status(404).json({ error: 'item not found' });

  writeJSON(FRIDGE_PATH, items);
  res.json({ success: true });
});

// GET /api/appliances
app.get('/api/appliances', (req, res) => {
  res.json(readJSON(APPLIANCES_PATH));
});

// POST /api/appliances/:device
app.post('/api/appliances/:device', (req, res) => {
  const { device } = req.params;
  const { action, value } = req.body;

  let appliances = readJSON(APPLIANCES_PATH);
  if (!Array.isArray(appliances)) appliances = [];

  let found = appliances.find(a => a.device === device);
  if (!found) {
    found = { device };
    appliances.push(found);
  }

  if (action) found.action = action;
  if (value !== undefined) found.value = value;
  found.updatedAt = new Date().toISOString();

  writeJSON(APPLIANCES_PATH, appliances);
  res.json(found);
});

app.listen(PORT, () => {
  console.log(`AI Home API server running on port ${PORT}`);
});
