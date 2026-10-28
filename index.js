import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const {
  BOT_TOKEN,
  BOT_USERNAME = '',
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BASE_URL = 'http://localhost:3000',
  PORT = 3000,
  APP_NAME = 'TeleCal',
  CONTACT_EMAIL = 'support@example.com',
  DEFAULT_TZ = 'UTC',
  STATE_SECRET = BOT_TOKEN,
} = process.env;

if (!BOT_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing BOT_TOKEN, GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

// Only what we need: create calendar events, send email. No reading of mail or calendars.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
];

const PRIVACY_URL = process.env.PRIVACY_URL || `${BASE_URL}/privacy`;
const TERMS_URL = process.env.TERMS_URL || `${BASE_URL}/terms`;

// ---------- tiny JSON store: { [chatId]: { tokens, tz } } ----------
const DB_FILE = path.resolve('data/users.json');
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
const save = () => {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

// ---------- Google auth ----------
const newOAuth = () =>
  new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/oauth/callback`);

function authFor(chatId) {
  const user = db[chatId];
  if (!user?.tokens) return null;
  const client = newOAuth();
  client.setCredentials(user.tokens);
  client.on('tokens', (t) => {
    user.tokens = { ...user.tokens, ...t };
    save();
  });
  return client;
}

// OAuth state = chatId + HMAC, so nobody can link their Google account to someone else's chat.
const sig = (id) => crypto.createHmac('sha256', STATE_SECRET).update(String(id)).digest('hex');
const signState = (id) => `${id}.${sig(id)}`;
function verifyState(state = '') {
  const [id, mac] = String(state).split('.');
  if (!id || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sig(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
const args = (ctx) => ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '');
const parts = (s) => s.split('|').map((p) => p.trim());
const oneLine = (s) => s.replace(/[\r\n]+/g, ' ').trim();
const tzOf = (chatId) => db[chatId]?.tz || DEFAULT_TZ;
const validTz = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const legalButtons = Markup.inlineKeyboard([
  Markup.button.url('Privacy Policy', PRIVACY_URL),
  Markup.button.url('Terms of Service', TERMS_URL),
]);

function requireAuth(ctx) {
  const auth = authFor(ctx.chat.id);
  if (!auth) ctx.reply('Connect your Google account first: /connect');
  return auth;
}

// Pending actions waiting for the user to tap Confirm.
const pending = new Map();
function askConfirm(ctx, summary, run) {
  const id = crypto.randomBytes(6).toString('hex');
  pending.set(id, { chatId: ctx.chat.id, run });
  setTimeout(() => pending.delete(id), 10 * 60 * 1000);
  return ctx.reply(summary, Markup.inlineKeyboard([
    Markup.button.callback('Confirm', `ok:${id}`),
    Markup.button.callback('Cancel', `no:${id}`),
  ]));
}

// ---------- bot ----------
const bot = new Telegraf(BOT_TOKEN);

const HELP = `${APP_NAME} — calendar meetings & emails from Telegram.

/connect — link your Google account
/meet Title | 2026-11-03 14:00 | 30 | a@x.com, b@y.com
   (duration in minutes and guests are optional)
/email to@x.com | Subject | Message
/tz Asia/Yangon — set your time zone
/disconnect — unlink and delete your data
/privacy · /terms`;

bot.start((ctx) => ctx.reply(HELP, legalButtons));
bot.help((ctx) => ctx.reply(HELP, legalButtons));
bot.command('privacy', (ctx) => ctx.reply(PRIVACY_URL));
bot.command('terms', (ctx) => ctx.reply(TERMS_URL));

bot.command('connect', (ctx) => {
  const url = newOAuth().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: signState(ctx.chat.id),
  });
  return ctx.reply(
    `Tap to connect Google. By connecting you agree to the Terms of Service and Privacy Policy.`,
    Markup.inlineKeyboard([
      [Markup.button.url('Connect Google', url)],
      [Markup.button.url('Privacy', PRIVACY_URL), Markup.button.url('Terms', TERMS_URL)],
    ]),
  );
});

bot.command('disconnect', async (ctx) => {
  const auth = authFor(ctx.chat.id);
  if (auth) await auth.revokeCredentials().catch(() => {});
  delete db[ctx.chat.id];
  save();
  return ctx.reply('Disconnected. Your data has been deleted.');
});

bot.command('tz', (ctx) => {
  const tz = args(ctx);
  if (!tz) return ctx.reply(`Your time zone: ${tzOf(ctx.chat.id)}\nChange it: /tz Europe/London`);
  if (!validTz(tz)) return ctx.reply('Unknown time zone. Example: /tz America/New_York');
  db[ctx.chat.id] = { ...db[ctx.chat.id], tz };
  save();
  return ctx.reply(`Time zone set to ${tz}`);
});

bot.command('meet', (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;

  const [title, when, mins = '30', guests = ''] = parts(args(ctx));
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/.exec(when || '');
  const duration = Number(mins);
  if (!title || !m || !(duration > 0)) {
    return ctx.reply('Usage: /meet Title | 2026-11-03 14:00 | 30 | a@x.com, b@y.com');
  }
  const emails = guests.split(',').map((e) => e.trim()).filter(Boolean);
  const bad = emails.find((e) => !EMAIL_RE.test(e));
  if (bad) return ctx.reply(`Invalid email: ${bad}`);

  // Do the date math as "wall clock" time; Google applies the time zone.
  const startUtc = new Date(`${m[1]}T${m[2].padStart(5, '0')}:00Z`);
  if (Number.isNaN(startUtc.getTime())) return ctx.reply('Invalid date.');
  const local = (d) => d.toISOString().slice(0, 19);
  const tz = tzOf(ctx.chat.id);
  const start = local(startUtc);
  const end = local(new Date(startUtc.getTime() + duration * 60000));

  const summary = `Create meeting?\n\n${title}\n${m[1]} ${m[2]} (${tz}), ${duration} min` +
    (emails.length ? `\nInvite: ${emails.join(', ')}` : '');

  return askConfirm(ctx, summary, async () => {
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      conferenceDataVersion: 1,
      requestBody: {
        summary: title,
        start: { dateTime: start, timeZone: tz },
        end: { dateTime: end, timeZone: tz },
        attendees: emails.map((email) => ({ email })),
        conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
      },
    });
    return `Meeting created ✅\n${data.htmlLink}` + (data.hangoutLink ? `\nMeet: ${data.hangoutLink}` : '');
  });
});

bot.command('email', (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;

  const [to, subject, ...rest] = parts(args(ctx));
  const body = rest.join(' | ');
  if (!to || !subject || !body) return ctx.reply('Usage: /email to@x.com | Subject | Message');
  const recipients = to.split(',').map((e) => e.trim()).filter(Boolean);
  const bad = recipients.find((e) => !EMAIL_RE.test(e));
  if (bad) return ctx.reply(`Invalid email: ${bad}`);

  return askConfirm(ctx, `Send email?\n\nTo: ${recipients.join(', ')}\nSubject: ${subject}\n\n${body}`, async () => {
    const mime = [
      `To: ${recipients.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(oneLine(subject)).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mime).toString('base64url') },
    });
    return 'Email sent ✅';
  });
});

bot.action(/^(ok|no):(\w+)$/, async (ctx) => {
  const [, choice, id] = ctx.match;
  const item = pending.get(id);
  await ctx.answerCbQuery();
  if (!item || item.chatId !== ctx.chat.id) return ctx.editMessageText('This request expired.');
  pending.delete(id);
  if (choice === 'no') return ctx.editMessageText('Cancelled.');
  try {
    await ctx.editMessageText(await item.run());
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`Failed: ${err.message}`);
  }
});

// ---------- web: landing, legal pages, OAuth callback ----------
const app = express();
const page = (file) => (_req, res) => {
  const html = fs
    .readFileSync(path.resolve('public', file), 'utf8')
    .replaceAll('{{APP_NAME}}', APP_NAME)
    .replaceAll('{{CONTACT_EMAIL}}', CONTACT_EMAIL)
    .replaceAll('{{BOT_URL}}', BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : '#');
  res.type('html').send(html);
};

app.get('/', page('index.html'));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.use('/static', express.static(path.resolve('public')));

app.get('/oauth/callback', async (req, res) => {
  const chatId = verifyState(req.query.state);
  if (!chatId || !req.query.code) return res.status(400).send('Invalid request.');
  try {
    const { tokens } = await newOAuth().getToken(String(req.query.code));
    db[chatId] = { ...db[chatId], tokens };
    save();
    await bot.telegram.sendMessage(chatId, 'Google connected ✅ Try /meet or /email');
    res.send(`<meta name="viewport" content="width=device-width"><p style="font-family:system-ui;padding:2rem">Connected. You can return to Telegram.</p>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not connect. Please try /connect again.');
  }
});

app.listen(PORT, () => console.log(`Web on ${BASE_URL} (port ${PORT})`));

bot.telegram.setMyCommands([
  { command: 'meet', description: 'Create a calendar meeting' },
  { command: 'email', description: 'Send an email' },
  { command: 'connect', description: 'Link Google account' },
  { command: 'tz', description: 'Set time zone' },
  { command: 'disconnect', description: 'Unlink and delete data' },
  { command: 'privacy', description: 'Privacy Policy' },
  { command: 'terms', description: 'Terms of Service' },
]);
bot.launch();
console.log('Bot running');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
