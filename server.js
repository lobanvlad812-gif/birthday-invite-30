const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8030;
const ADMIN_PIN = process.env.ADMIN_PIN || '1212';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rsvp.json');

// Ensure data folder and file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf8');
}

// ── Persistent PostgreSQL Database Setup ──
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    pool.query(`
      CREATE TABLE IF NOT EXISTS rsvp_responses (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        attend VARCHAR(16) NOT NULL,
        with_pair BOOLEAN NOT NULL DEFAULT FALSE,
        drink VARCHAR(64) NOT NULL DEFAULT 'anything',
        drink_label VARCHAR(64) NOT NULL DEFAULT 'Всё что нальют',
        wishes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        ip VARCHAR(128)
      );
    `).then(() => {
      console.log('✓ PostgreSQL connected and rsvp_responses table ready');
    }).catch(err => {
      console.error('PostgreSQL table init error:', err);
    });
  } catch (err) {
    console.error('Failed to initialize Postgres pool:', err);
  }
}

function loadResponsesFromFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading data file:', err);
    return [];
  }
}

function saveResponsesToFile(list) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing data file:', err);
    return false;
  }
}

async function getAllResponses() {
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM rsvp_responses ORDER BY created_at DESC');
      return res.rows.map(r => ({
        id: r.id,
        name: r.name,
        attend: r.attend,
        with_pair: Boolean(r.with_pair),
        drink: r.drink,
        drink_label: r.drink_label,
        wishes: r.wishes || '',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        ip: r.ip || ''
      }));
    } catch (err) {
      console.error('Database query error, falling back to file:', err);
    }
  }
  return loadResponsesFromFile();
}

async function saveResponse(entry) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO rsvp_responses (id, name, attend, with_pair, drink, drink_label, wishes, created_at, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [entry.id, entry.name, entry.attend, entry.with_pair, entry.drink, entry.drink_label, entry.wishes, entry.created_at, entry.ip]
      );
      return true;
    } catch (err) {
      console.error('Database insert error, falling back to file:', err);
    }
  }
  const responses = loadResponsesFromFile();
  responses.unshift(entry);
  saveResponsesToFile(responses);
  return true;
}

async function deleteResponse(id) {
  if (pool) {
    try {
      const res = await pool.query('DELETE FROM rsvp_responses WHERE id = $1', [id]);
      return res.rowCount;
    } catch (err) {
      console.error('Database delete error, falling back to file:', err);
    }
  }
  const list = loadResponsesFromFile();
  const next = list.filter(r => r.id !== id);
  saveResponsesToFile(next);
  return list.length - next.length;
}

// Drink translation dictionary for display
const DRINK_LABELS = {
  none: 'Не пьёт',
  vodka: 'Водка',
  whisky: 'Виски',
  wine: 'Вино',
  champagne: 'Шампанское',
  anything: 'Всё что нальют'
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache frame images for fast loading
app.use('/frames', express.static(path.join(__dirname, 'frames'), {
  maxAge: '7d',
  immutable: true
}));
app.use('/mobile_frames', express.static(path.join(__dirname, 'mobile_frames'), {
  maxAge: '7d',
  immutable: true
}));

// Never cache index.html so client code and asset version strings are always immediately fresh
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve index and static assets
app.use(express.static(__dirname));

// ── API: Submit RSVP Form ──
app.post('/api/rsvp', async (req, res) => {
  const { name, attend, with_pair, drink, wishes } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'Пожалуйста, укажите имя' });
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    name: name.trim(),
    attend: attend === 'yes' ? 'yes' : 'no',
    with_pair: Boolean(with_pair),
    drink: drink || 'anything',
    drink_label: DRINK_LABELS[drink] || drink || 'Всё что нальют',
    wishes: (wishes || '').trim(),
    created_at: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
  };

  await saveResponse(entry);

  console.log(`[RSVP] Новый ответ от "${entry.name}": придет=${entry.attend}, с парой=${entry.with_pair}, напиток=${entry.drink}`);

  // Optional Telegram notification if credentials provided
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    sendTelegramNotification(entry).catch(err => console.error('TG Notification error:', err));
  }

  res.json({ ok: true, id: entry.id });
});

// ── API: Get All Responses (Admin only) ──
app.get('/api/rsvp', async (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: 'Неверный PIN-код' });
  }

  const list = await getAllResponses();

  // Compute summary stats
  const total = list.length;
  const attending = list.filter(r => r.attend === 'yes');
  const notAttending = list.filter(r => r.attend === 'no');
  const withPairCount = attending.filter(r => r.with_pair).length;
  const totalGuests = attending.length + withPairCount;

  const drinksStats = {};
  Object.keys(DRINK_LABELS).forEach(k => { drinksStats[k] = 0; });
  attending.forEach(r => {
    const k = r.drink || 'anything';
    drinksStats[k] = (drinksStats[k] || 0) + 1;
  });

  res.json({
    ok: true,
    stats: {
      total,
      attendingCount: attending.length,
      notAttendingCount: notAttending.length,
      withPairCount,
      totalGuests,
      drinksStats,
      drinkLabels: DRINK_LABELS
    },
    items: list
  });
});

// ── API: Delete Response (Admin only) ──
app.delete('/api/rsvp/:id', async (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: 'Неверный PIN-код' });
  }

  const { id } = req.params;
  const deleted = await deleteResponse(id);

  res.json({ ok: true, deleted });
});

// ── API: Export to Excel / CSV ──
app.get('/api/rsvp/export', async (req, res) => {
  const pin = req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).send('Неверный PIN-код');
  }

  const list = await getAllResponses();

  // UTF-8 BOM so Excel opens Cyrillic characters perfectly
  let csv = '\uFEFF';
  csv += 'Дата;Имя и Фамилия;Будет?;С парой?;Напиток;Пожелания\n';

  list.forEach(r => {
    const dateStr = new Date(r.created_at).toLocaleString('ru-RU');
    const nameStr = `"${(r.name || '').replace(/"/g, '""')}"`;
    const attendStr = r.attend === 'yes' ? 'Да' : 'Нет';
    const pairStr = r.with_pair ? 'Да' : 'Нет';
    const drinkStr = `"${(DRINK_LABELS[r.drink] || r.drink || '').replace(/"/g, '""')}"`;
    const wishesStr = `"${(r.wishes || '').replace(/"/g, '""')}"`;
    csv += `${dateStr};${nameStr};${attendStr};${pairStr};${drinkStr};${wishesStr}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rsvp_jubilee_30.csv"');
  res.send(csv);
});

// ── Admin UI Page ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Optional Telegram Notification Helper
async function sendTelegramNotification(entry) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const statusText = entry.attend === 'yes' ? '✅ Да, придёт!' : '😢 Не сможет прийти';
  const pairText = entry.with_pair ? '💑 Да, будет с парой' : '👤 Один';
  const drink = entry.drink_label || entry.drink;
  const wishes = entry.wishes ? `\n💬 *Пожелания:* _${escapeMarkdown(entry.wishes)}_` : '';

  const text = `🎉 *Новый ответ на юбилей 30 лет!*

👤 *Гость:* ${escapeMarkdown(entry.name)}
📊 *Статус:* ${statusText}
👫 *С парой:* ${pairText}
🥂 *Напиток:* ${escapeMarkdown(drink)}${wishes}
⏱ _${new Date(entry.created_at).toLocaleString('ru-RU')}_`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });
}

function escapeMarkdown(str) {
  return (str || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Birthday Landing Server started:`);
  console.log(`👉 Main Landing: http://localhost:${PORT}`);
  console.log(`👉 Admin Panel:  http://localhost:${PORT}/admin (PIN: ${ADMIN_PIN})`);
});
