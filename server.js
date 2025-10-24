import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import pino from 'pino';
import { Storage } from 'megajs';
import { fileURLToPath } from 'url';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  delay
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SESSION_BASE_PATH = process.env.SESSION_BASE_PATH || path.join(__dirname, 'sessions');
fs.ensureDirSync(SESSION_BASE_PATH);

const DB_PATH = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_PATH)) fs.writeJsonSync(DB_PATH, { sessions: [] }, { spaces: 2 });
const readDB = () => fs.readJsonSync(DB_PATH);
const writeDB = (d) => fs.writeJsonSync(DB_PATH, d, { spaces: 2 });

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/** Upload creds.json to MEGA and return the share link */
async function uploadCredsToMega(credsPath) {
  if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASS) {
    throw new Error('MEGA_EMAIL and MEGA_PASS must be set in .env');
  }

  const storage = new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASS
  });

  await storage.ready;

  const size = fs.statSync(credsPath).size;
  const name = `Sila-${Date.now()}.json`;

  const upload = await storage.upload({ name, size }, fs.createReadStream(credsPath)).complete;
  const node = storage.files[upload.nodeId];
  const link = await node.link(); // e.g. https://mega.nz/file/<CODE>#<KEY>
  return link;
}

/** Helper to extract mega file code */
function extractMegaFileCode(megaLink) {
  if (!megaLink) return null;
  const m = megaLink.match(/mega\.nz\/file\/([^#?\/]+)/);
  if (m) return m[1];
  // fallback: base64 short code
  return Buffer.from(megaLink).toString('base64').slice(0, 12);
}

/** Serve UI */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});

/**
 * POST /pair
 * body: { number: "2557xxxxxxx" }
 * Response:
 *  - { status: 'pairing_code_sent', code } OR
 *  - { status: 'paired', sid: 'Sila~<CODE>', megaLink }
 */
app.post('/pair', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'number required' });

    const sanitized = ('' + number).replace(/\D/g, '');
    if (sanitized.length < 7) return res.status(400).json({ error: 'invalid number' });

    const sessionPath = path.join(SESSION_BASE_PATH, `sila_${sanitized}`);
    await fs.ensureDir(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: state.keys },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (e) { logger.error(e, 'saveCreds'); }
    });

    let responded = false;

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection } = update;
        logger.info({ connection, number: sanitized }, 'connection.update');

        if (connection === 'open') {
          const credsFile = path.join(sessionPath, 'creds.json');
          if (!fs.existsSync(credsFile)) {
            logger.error('creds.json not found after open');
            if (!responded) { responded = true; res.status(500).json({ error: 'creds_not_found' }); }
            return;
          }

          try {
            const megaLink = await uploadCredsToMega(credsFile);
            const code = extractMegaFileCode(megaLink);
            const sid = `Sila~${code}`;

            const db = readDB();
            db.sessions = db.sessions || [];
            db.sessions.push({ sid, number: sanitized, megaLink, createdAt: new Date().toISOString() });
            writeDB(db);

            // try to notify the account's jid (best-effort)
            try {
              const myJid = sock.user?.id ? sock.user.id : null;
              if (myJid) await sock.sendMessage(myJid, { text: `Paired ${sanitized}\nSession ID: ${sid}` });
            } catch (notifyErr) {
              logger.warn({ notifyErr }, 'notify owner failed');
            }

            if (!responded) {
              responded = true;
              res.json({ status: 'paired', sid, megaLink });
            }
          } catch (uploadErr) {
            logger.error({ uploadErr }, 'upload to MEGA failed');
            if (!responded) { responded = true; res.status(500).json({ error: 'upload_failed', details: String(uploadErr) }); }
          }
        } else if (connection === 'close') {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if (!responded && code === DisconnectReason.loggedOut) {
            responded = true;
            res.status(500).json({ error: 'logged_out' });
          }
        }
      } catch (e) {
        logger.error({ e }, 'connection.update handler error');
      }
    });

    // request pairing code if not registered
    if (!sock.authState.creds.registered) {
      let pairingCode = null;
      let tries = 3;
      while (tries > 0 && !pairingCode) {
        try {
          await delay(1000);
          pairingCode = await sock.requestPairingCode(sanitized);
          if (pairingCode) {
            if (!responded) {
              responded = true;
              return res.json({ status: 'pairing_code_sent', code: pairingCode, message: 'Open WhatsApp → Linked Devices → Link a device, then enter code.' });
            }
          }
        } catch (err) {
          tries--;
          logger.warn({ err, tries }, 'requestPairingCode failed');
          if (tries <= 0 && !responded) {
            responded = true;
            return res.status(500).json({ error: 'failed_to_generate_pairing_code' });
          }
        }
      }
    } else {
      if (!responded) { responded = true; res.json({ status: 'already_registered', message: 'This number appears registered. Waiting for connection open.' }); }
    }

    // safety timeout
    setTimeout(() => {
      if (!responded) {
        responded = true;
        try { res.status(202).json({ status: 'waiting', message: 'Waiting for pairing to complete.' }); } catch (e) {}
      }
    }, 30000);

  } catch (err) {
    logger.error({ err }, 'pair endpoint error');
    try { res.status(500).json({ error: String(err) }); } catch (e) {}
  }
});

/** List stored Sila~ sessions (non-sensitive) */
app.get('/sessions', (req, res) => {
  try { const db = readDB(); res.json(db.sessions || []); } catch (e) { res.status(500).json({ error: 'failed_to_read_db' }); }
});

app.listen(PORT, () => logger.info(`Sila Session Generator running on http://localhost:${PORT}`));
