import { makeWASocket, useMultiFileAuthState, DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { rm } from 'fs/promises';
import { io } from '../server.js';
import { ConversationService } from './conversation.service.js';
import { BotEngineService } from './botEngine.service.js';
import { AuthService } from './auth.service.js';

export type WhatsappConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface WhatsappSession {
  socket: WASocket;
  status: WhatsappConnectionStatus;
  qrDataUrl: string | null;
}

// Sesiones en memoria, una por usuario (multi-tenant: cada usuario escanea su propio WhatsApp).
// Si el proceso se reinicia, las sesiones ya autenticadas se pueden retomar solas gracias a las
// credenciales persistidas en disco por useMultiFileAuthState (no hace falta volver a escanear
// el QR, salvo que la sesión haya sido deslogueada desde el teléfono o se haya llamado a disconnect()).
const sessions = new Map<number, WhatsappSession>();

function authStateDir(userId: number): string {
  return `baileys_auth_state_${userId}`;
}

function emitStatus(userId: number, status: WhatsappConnectionStatus) {
  io.emit('whatsapp_status_updated', { userId, status });
}

/**
 * Borra la sesión en memoria y las credenciales persistidas en disco de un usuario. Hace falta
 * llamar esto (no alcanza con sacar la sesión del Map) cada vez que la sesión de WhatsApp deja
 * de ser válida — logout desde el teléfono o logout disparado por nosotros — porque
 * useMultiFileAuthState() reutiliza lo que haya en esa carpeta en el próximo connect(). Si no se
 * borra, el siguiente intento de conexión falla con las credenciales viejas ya invalidadas por
 * WhatsApp.
 */
async function clearSession(userId: number): Promise<void> {
  sessions.delete(userId);

  try {
    await rm(authStateDir(userId), { recursive: true, force: true });
  } catch (err) {
    console.error(`⚠️ [WhatsApp] Error borrando las credenciales locales del usuario ${userId}:`, err);
  }
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

    const { state, saveCreds } = await useMultiFileAuthState(authStateDir(userId));
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
        // desde el teléfono, ej. "Cerrar sesión" en WhatsApp > Dispositivos vinculados) viene en
        // output.statusCode. Cualquier otro motivo de cierre (timeout, conexión perdida, etc.)
        // amerita reintentar solo, conservando las credenciales.
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          // Las credenciales en disco quedaron invalidadas del lado de WhatsApp: si no las
          // borramos acá, el próximo connect() de este usuario intenta reusarlas y falla.
          await clearSession(userId);
        } else {
          sessions.delete(userId);
        }

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

    // Se pide ANTES de loguear el mensaje entrante actual: son los turnos previos de la
    // conversación, sin incluir todavía este mensaje (que se lo pasamos aparte a
    // processIncomingMessage como incomingText).
    const priorMessages = await ConversationService.getMessages(conversation.id);
    const history = ConversationService.toAiHistory(priorMessages ?? []);

    const inbound = await ConversationService.addMessage(conversation.id, 'customer', text);
    if (inbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', inbound.message);
      io.emit('conversation_updated', inbound.conversation);
    }

    // Cancelar mensajes programados que tengan activa la regla de "Detener si el contacto responde"
    try {
      const { ScheduledJobService } = await import('./scheduledJob.service.js');
      await ScheduledJobService.cancelPendingOnContactReply(phone);
    } catch (err) {
      console.warn('[WhatsApp] Error cancelando programados al recibir respuesta:', err);
    }

    // Switch "Habilitar bot" del panel (PUT /api/whatsapp/bot-enabled): el mensaje del cliente
    // queda igual registrado en la conversación arriba, pero si está apagado no autorespondemos.
    const user = await AuthService.getUserById(userId);
    if (!user?.botEnabled) return;

    const botResult = await BotEngineService.processIncomingMessage(
      text,
      phone,
      history,
      {},
      user.aiFallbackEnabled,
      user.aiCustomInstructions
    );
    if (!botResult) return; // "Responder con IA" apagado y ninguna regla matcheó: sin respuesta automática.

    await socket.sendMessage(remoteJid, { text: botResult.replyText });

    const outbound = await ConversationService.addMessage(conversation.id, 'bot', botResult.replyText);
    if (outbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', outbound.message);
      io.emit('conversation_updated', outbound.conversation);
    }
  }

  static async disconnect(userId: number): Promise<void> {
    const session = sessions.get(userId);
    if (session) {
      try {
        session.socket.end(undefined);
      } catch (err) {
        console.error(`⚠️ [WhatsApp] Error cerrando el socket del usuario ${userId}:`, err);
      }
    }

    await clearSession(userId);
    emitStatus(userId, 'disconnected');
  }

  /**
   * Envía un mensaje de texto saliente por WhatsApp usando la sesión activa del usuario (o la primera conectada).
   */
  static async sendTextMessage(phone: string, text: string, userId?: number): Promise<boolean> {
    let targetSession: WhatsappSession | undefined;
    if (userId) {
      targetSession = sessions.get(userId);
    } else {
      for (const s of sessions.values()) {
        if (s.status === 'connected') {
          targetSession = s;
          break;
        }
      }
    }

    if (!targetSession || targetSession.status !== 'connected') {
      throw new Error('No hay una sesión de WhatsApp conectada para enviar el mensaje.');
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await targetSession.socket.sendMessage(jid, { text });
    return true;
  }
}
