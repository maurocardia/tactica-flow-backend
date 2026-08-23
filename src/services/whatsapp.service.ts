import { makeWASocket, useMultiFileAuthState, DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { io } from '../server.js';
import { ConversationService } from './conversation.service.js';
import { BotEngineService } from './botEngine.service.js';

export type WhatsappConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface WhatsappSession {
  socket: WASocket;
  status: WhatsappConnectionStatus;
  qrDataUrl: string | null;
}

// Sesiones en memoria, una por usuario (multi-tenant: cada usuario escanea su propio WhatsApp).
// Si el proceso se reinicia, las sesiones ya autenticadas se pueden retomar solas gracias a las
// credenciales persistidas en disco por useMultiFileAuthState (no hace falta volver a escanear
// el QR, salvo que la sesión haya sido deslogueada desde el teléfono).
const sessions = new Map<number, WhatsappSession>();

function emitStatus(userId: number, status: WhatsappConnectionStatus) {
  io.emit('whatsapp_status_updated', { userId, status });
}

export class WhatsappService {
  static getStatus(userId: number): WhatsappConnectionStatus {
    return sessions.get(userId)?.status ?? 'disconnected';
  }

  static getQr(userId: number): string | null {
    return sessions.get(userId)?.qrDataUrl ?? null;
  }

  static async connect(userId: number): Promise<{ status: WhatsappConnectionStatus }> {
    const existing = sessions.get(userId);
    if (existing) {
      return { status: existing.status };
    }

    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_state_${userId}`);
    const socket = makeWASocket({ auth: state });

    const session: WhatsappSession = { socket, status: 'connecting', qrDataUrl: null };
    sessions.set(userId, session);
    emitStatus(userId, 'connecting');

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        session.qrDataUrl = await qrcode.toDataURL(qr);
        session.status = 'qr_ready';
        emitStatus(userId, 'qr_ready');
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.qrDataUrl = null;
        emitStatus(userId, 'connected');
      }

      if (connection === 'close') {
        // lastDisconnect.error es un Boom; el código HTTP-like que nos importa (401 = deslogueado
        // desde el teléfono) viene en output.statusCode. Cualquier otro motivo de cierre
        // (timeout, conexión perdida, etc.) amerita reintentar solo.
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        sessions.delete(userId);
        emitStatus(userId, 'disconnected');

        if (!loggedOut) {
          WhatsappService.connect(userId).catch((err) => {
            console.error(`❌ [WhatsApp] Error reconectando la sesión del usuario ${userId}:`, err);
          });
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      // "notify" = mensajes nuevos en vivo. Otros tipos (ej. "append") son resincronización de
      // historial al reconectar, no queremos que el bot responda mensajes viejos.
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await WhatsappService.handleIncomingMessage(userId, socket, msg);
        } catch (err) {
          console.error(`❌ [WhatsApp] Error procesando mensaje entrante (usuario ${userId}):`, err);
        }
      }
    });

    return { status: session.status };
  }

  private static async handleIncomingMessage(userId: number, socket: WASocket, msg: any): Promise<void> {
    const remoteJid: string | undefined = msg.key?.remoteJid;
    if (!remoteJid || msg.key?.fromMe) return;
    if (remoteJid.endsWith('@g.us')) return; // ignorar mensajes de grupos

    const text: string | undefined = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!text) return; // ignorar mensajes sin texto (imágenes, audios, etc.) por ahora

    const phone = remoteJid.split('@')[0];
    const contactName: string = msg.pushName || phone;

    const conversation = await ConversationService.findOrCreateByPhone(phone, contactName, userId);

    const inbound = await ConversationService.addMessage(conversation.id, 'customer', text);
    if (inbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', inbound.message);
      io.emit('conversation_updated', inbound.conversation);
    }

    const botResult = await BotEngineService.processIncomingMessage(text, phone, [], {});
    await socket.sendMessage(remoteJid, { text: botResult.replyText });

    const outbound = await ConversationService.addMessage(conversation.id, 'bot', botResult.replyText);
    if (outbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', outbound.message);
      io.emit('conversation_updated', outbound.conversation);
    }
  }

  static async disconnect(userId: number): Promise<void> {
    const session = sessions.get(userId);
    if (!session) return;

    sessions.delete(userId);

    try {
      await session.socket.logout();
    } catch (err) {
      // Puede fallar si la conexión ya estaba caída del otro lado; igual ya limpiamos la sesión.
      console.error(`⚠️ [WhatsApp] Error cerrando sesión del usuario ${userId}:`, err);
    }

    emitStatus(userId, 'disconnected');
  }
}
