const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

function loadResponses() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading data file:', err);
    return [];
  }
}

function saveResponses(list) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing data file:', err);
    return false;
  }
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

// Serve index and static assets
app.use(express.static(__dirname));

// ── API: Submit RSVP Form ──
app.post('/api/rsvp', (req, res) => {
  const { name, attend, with_pair, drink, wishes } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'Пожалуйста, укажите имя' });
  }

  const responses = loadResponses();
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

  responses.unshift(entry);
  saveResponses(responses);

  console.log(`[RSVP] Новый ответ от "${entry.name}": придет=${entry.attend}, с парой=${entry.with_pair}, напиток=${entry.drink}`);

  // Optional Telegram notification if credentials provided
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    sendTelegramNotification(entry).catch(err => console.error('TG Notification error:', err));
  }

  res.json({ ok: true, id: entry.id });
});

// ── API: Get All Responses (Admin only) ──
app.get('/api/rsvp', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: 'Неверный PIN-код' });
  }

  const list = loadResponses();

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
app.delete('/api/rsvp/:id', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: 'Неверный PIN-код' });
  }

  const { id } = req.params;
  const list = loadResponses();
  const next = list.filter(r => r.id !== id);
  saveResponses(next);

  res.json({ ok: true, deleted: list.length - next.length });
});

// ── API: Export to Excel / CSV ──
app.get('/api/rsvp/export', (req, res) => {
  const pin = req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).send('Неверный PIN-код');
  }

  const list = loadResponses();

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
