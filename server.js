require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const pino = require('pino');
const { Storage } = require('megajs');
const os = require('os');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  delay
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SESSION_BASE_PATH = process.env.SESSION_BASE_PATH || path.join(__dirname, 'sessions');
fs.ensureDirSync(SESSION_BASE_PATH);

const DB_PATH = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_PATH)) fs.writeJsonSync(DB_PATH, { sessions: [] }, { spaces: 2 });
function readDB() { return fs.readJsonSync(DB_PATH); }
function writeDB(d) { fs.writeJsonSync(DB_PATH, d, { spaces: 2 }); }

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

  // upload returns an object with nodeId
  const upload = await storage.upload({ name, size }, fs.createReadStream(credsPath)).complete;
  const node = storage.files[upload.nodeId];
  const link = await node.link(); // e.g. https://mega.nz/file/<CODE>#<KEY>
  return link;
}

/** Serve simple UI */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});

/**
 * POST /pair
 * body: { number: "2557xxxxxxx" }
 * Response:
 *  - { status: 'pairing_code_sent', code }   OR
 *  - { status: 'paired', sid: 'Sila~<CODE>', megaLink }
 */
app.post('/pair', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'number required' });

    const sanitized = ('' + number).replace(/\D/g, '');
    if (sanitized.length < 8) return res.status(400).json({ error: 'invalid number' });

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
      try { await saveCreds(); } catch (e) { logger.error('saveCreds error', e); }
    });

    let responded = false;

    // connection update: when open -> upload creds -> return Sila~id
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        logger.info({ connection, number: sanitized }, 'connection.update');

        if (connection === 'open') {
          // ensure creds exist
          const credsFile = path.join(sessionPath, 'creds.json');
          if (!fs.existsSync(credsFile)) {
            logger.error('creds.json not found after open');
            if (!responded) { responded = true; res.status(500).json({ error: 'creds_not_found' }); }
            return;
          }

          try {
            const megaLink = await uploadCredsToMega(credsFile);
            // try to extract code after /file/
            const m = megaLink.match(/mega\\.nz\\/file\\/(.*?)(?:#|$)/);
            const code = m ? m[1] : Buffer.from(megaLink).toString('base64').slice(0, 12);
            const sid = `Sila~${code}`;

            // persist to db
            const db = readDB();
            db.sessions = db.sessions || [];
            db.sessions.push({ sid, number: sanitized, megaLink, createdAt: new Date().toISOString() });
            writeDB(db);

            // respond via HTTP if still waiting
            if (!responded) {
              responded = true;
              res.json({ status: 'paired', sid, megaLink });
            }

            // optionally notify the account itself (owner) - best-effort
            try {
              const myJid = await sock.decodeJid(sock.user.id);
              await sock.sendMessage(myJid, { text: `Pairing complete for ${sanitized}\nSession ID: ${sid}` });
            } catch (notifyErr) {
              logger.warn({ notifyErr }, 'failed to notify owner jid');
            }
          } catch (uploadErr) {
            logger.error({ uploadErr }, 'upload to MEGA failed');
            if (!responded) { responded = true; res.status(500).json({ error: 'upload_failed', details: String(uploadErr) }); }
          }
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (!responded && code === DisconnectReason.loggedOut) {
            responded = true;
            res.status(500).json({ error: 'logged_out' });
          }
        }
      } catch (e) {
        logger.error({ e }, 'connection.update handler error');
      }
    });

    // if not registered, request pairing code and return it immediately
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
              return res.json({ status: 'pairing_code_sent', code: pairingCode, message: 'Open WhatsApp â†’ Linked Devices â†’ Link a device, then enter code.' });
            }
          }
        } catch (err) {
          tries--;
          logger.warn({ err, tries }, 'requestPairingCode failed, retrying');
          if (tries <= 0 && !responded) {
            responded = true;
            return res.status(500).json({ error: 'failed_to_generate_pairing_code' });
          }
        }
      }
    } else {
      // already registered - the socket will open and upload creds; respond that it's already registered
      if (!responded) {
        responded = true;
        res.json({ status: 'already_registered', message: 'This number appears already registered. Waiting for connection open.' });
      }
    }

    // safety timeout: if nothing returns within 30s, inform client that pairing is pending
    setTimeout(() => {
      if (!responded) {
        responded = true;
        try { res.status(202).json({ status: 'waiting', message: 'Waiting for pairing to complete. If you already entered the code in WhatsApp, retry the request after a few seconds.' }); } catch (e) {}
      }
    }, 30000);

  } catch (err) {
    logger.error({ err }, 'pair endpoint error');
    try { res.status(500).json({ error: String(err) }); } catch (e) {}
  }
});

/** List stored Sila~ sessions (non-sensitive: returns stored MEGA link & sid) */
app.get('/sessions', (req, res) => {
  try {
    const db = readDB();
    res.json(db.sessions || []);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_read_db' });
  }
});

app.listen(PORT, () => logger.info(`Sila Session Generator running on http://localhost:${PORT}`));

