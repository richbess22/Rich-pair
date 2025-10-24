/**
 * server.js
 * WhatsApp Multi-Device bot using Baileys
 * Includes enhanced connection handling and error logging
 */

import express from 'express';
import { Boom } from '@hapi/boom';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join('./sessions');

// Utility: ensure session dir exists
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Utility: clean session folder
function clearSession(number) {
  const folder = path.join(SESSIONS_DIR, `sila_${number}`);
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
    console.log(`[INFO] Cleared session for ${number}`);
  }
}

// Route: Pair number
app.post('/pair', async (req, res) => {
  const { number } = req.body;
  if (!number || typeof number !== 'string') return res.status(400).json({ error: 'missing_number' });

  const sanitized = number.replace(/\D/g, ''); // remove any non-digit
  const sessionFolder = path.join(SESSIONS_DIR, `sila_${sanitized}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // optional
    logger: console,
  });

  let responded = false;

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect } = update;
      console.log(`[INFO] Connection update for ${sanitized}:`, connection);

      if (connection === 'open') {
        console.log(`[INFO] Connected successfully: ${sanitized}`);
        await saveCreds();
        if (!responded) {
          responded = true;
          res.json({ status: 'connected', number: sanitized });
        }
        return;
      }

      if (connection === 'connecting') return;

      if (connection === 'close') {
        console.error(`[ERROR] Connection closed for ${sanitized}:`, lastDisconnect);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || lastDisconnect?.error?.output || String(lastDisconnect);

        if (errMsg && /phone|number|invalid/i.test(errMsg)) {
          if (!responded) {
            responded = true;
            res.status(400).json({
              error: 'invalid_number_or_not_registered',
              details: 'Check phone number is correct and registered on WhatsApp.',
            });
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          if (!responded) {
            responded = true;
            res.status(400).json({
              error: 'logged_out',
              details: 'The account appears logged out. Try removing local session and re-pair.',
            });
          }
        } else {
          if (!responded) {
            responded = true;
            res.status(500).json({
              error: 'connection_failed',
              details: errMsg || 'Connection failed for unknown reason. See logs.',
            });
          }
        }

        try { sock.ws?.close(); } catch (e) {}
        return;
      }
    } catch (e) {
      console.error(`[ERROR] connection.update handler error:`, e);
      if (!responded) {
        responded = true;
        try { res.status(500).json({ error: 'internal_error', details: String(e) }); } catch (e2) {}
      }
    }
  });

  // Credential update
  sock.ev.on('creds.update', saveCreds);
});

// Route: Clear session
app.post('/clear-session', (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'missing_number' });
  clearSession(number);
  res.json({ status: 'cleared', number });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));
