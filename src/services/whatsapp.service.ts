import { makeWASocket, DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { io } from '../server.js';
import { db } from '../config/db.js';
import { ConversationService } from './conversation.service.js';
import { BotEngineService } from './botEngine.service.js';
import { AuthService } from './auth.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';
import { usePostgresAuthState } from './postgresAuthState.js';

export type WhatsappConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface WhatsappSession {
  socket: WASocket;
  status: WhatsappConnectionStatus;
  qrDataUrl: string | null;
}

// Sesiones en memoria, una por usuario (multi-tenant).
// Las credenciales se persisten de forma permanente en PostgreSQL (tabla whatsapp_sessions),
// por lo que reinicios o nuevos despliegues en Railway retoman la sesión automáticamente.
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

    const { state, saveCreds, clearCreds } = await usePostgresAuthState(userId);
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

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
        console.log(`✅ [WhatsApp] Sesión conectada y lista para el usuario ${userId}`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.warn(`🔒 [WhatsApp] Sesión cerrada desde el teléfono para usuario ${userId}`);
          sessions.delete(userId);
          await clearCreds();
        } else {
          sessions.delete(userId);
        }

        emitStatus(userId, 'disconnected');

        if (!loggedOut) {
          console.log(`🔄 [WhatsApp] Reconectando sesión de usuario ${userId} en 3 segundos...`);
          setTimeout(() => {
            WhatsappService.connect(userId).catch((err) => {
              console.error(`❌ [WhatsApp] Error reconectando sesión de usuario ${userId}:`, err);
            });
          }, 3000);
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
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
    if (!remoteJid) return;
    const fromMe = !!msg.key?.fromMe;

    const isGroup = remoteJid.endsWith('@g.us');
    const user = await AuthService.getUserById(userId);

    // Switch "Responder también en grupos": por default solo atiende chats individuales
    if (isGroup && !user?.botGroupsEnabled && !fromMe) return;

    const text: string | undefined = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!text) return;

    const participantJid: string | undefined = isGroup ? msg.key?.participant : undefined;
    if (isGroup && !participantJid && !fromMe) return;

    let contactName: string = msg.pushName || remoteJid.split('@')[0];
    let phone: string;
    let groupName: string | null = null;

    if (isGroup) {
      const part = participantJid ? participantJid.split('@')[0] : (fromMe ? 'agente' : 'participante');
      phone = `${remoteJid.split('@')[0]}-${part}`;
      try {
        const metadata = await socket.groupMetadata(remoteJid);
        if (metadata.subject) {
          groupName = metadata.subject;
          contactName = `${contactName} · ${metadata.subject}`;
        }
      } catch (err) {
        console.error(`⚠️ [WhatsApp] No se pudo obtener el nombre del grupo ${remoteJid}:`, err);
      }
    } else {
      phone = remoteJid.split('@')[0];
    }

    const conversation = await ConversationService.findOrCreateByPhone(phone, contactName, userId, groupName);

    // Si el mensaje lo envió el asesor humano o desde el teléfono/WhatsApp Web, lo guardamos como 'agent' y salimos
    if (fromMe) {
      const outbound = await ConversationService.addMessage(conversation.id, 'agent', text);
      if (outbound) {
        io.to(`chat_${conversation.id}`).emit('new_message', outbound.message);
        io.emit('conversation_updated', outbound.conversation);
      }
      return;
    }

    const priorMessages = await ConversationService.getMessages(conversation.id);
    const activeBaseIds = await KnowledgeBaseService.getActiveBaseIds();
    const history = ConversationService.toAiHistory(priorMessages ?? [], activeBaseIds);

    const inbound = await ConversationService.addMessage(conversation.id, 'customer', text);
    if (inbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', inbound.message);
      io.emit('conversation_updated', inbound.conversation);
    }

    // Cancelar mensajes programados si el contacto respondió
    try {
      const { ScheduledJobService } = await import('./scheduledJob.service.js');
      await ScheduledJobService.cancelPendingOnContactReply(phone);
    } catch (err) {
      console.warn('[WhatsApp] Error cancelando programados al recibir respuesta:', err);
    }

    if (!user?.botEnabled) return;

    const botResult = await BotEngineService.processIncomingMessage(
      text,
      phone,
      history,
      {},
      user.aiFallbackEnabled,
      user.aiCustomInstructions
    );
    if (!botResult) return;

    if (isGroup && participantJid) {
      await socket.sendMessage(remoteJid, {
        text: `@${participantJid.split('@')[0]} ${botResult.replyText}`,
        mentions: [participantJid]
      });
    } else {
      await socket.sendMessage(remoteJid, { text: botResult.replyText });
    }

    const outbound = await ConversationService.addMessage(conversation.id, 'bot', botResult.replyText, botResult.sourceKbIds);
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

    sessions.delete(userId);
    try {
      const { clearCreds } = await usePostgresAuthState(userId);
      await clearCreds();
    } catch (err) {
      console.error(`⚠️ [WhatsApp] Error borrando credenciales en PostgreSQL:`, err);
    }

    emitStatus(userId, 'disconnected');
  }

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

  /**
   * Reconecta automáticamente al iniciar el servidor todas las sesiones activas guardadas en PostgreSQL.
   */
  static async reconnectAllActiveSessions(): Promise<void> {
    try {
      const { rows } = await db.query(
        "SELECT DISTINCT user_id FROM whatsapp_sessions WHERE key_id = 'creds'"
      );
      if (rows.length > 0) {
        console.log(`🔌 [WhatsApp] Reconectando ${rows.length} sesión(es) persistidas en PostgreSQL...`);
        for (const row of rows) {
          WhatsappService.connect(row.user_id).catch((err) => {
            console.warn(`⚠️ [WhatsApp] Falló auto-reconexión para usuario ${row.user_id}:`, err);
          });
        }
      }
    } catch (err) {
      console.error('❌ [WhatsApp] Error al auto-reconectar sesiones desde PostgreSQL:', err);
    }
  }
}
