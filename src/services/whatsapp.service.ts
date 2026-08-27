import { makeWASocket, useMultiFileAuthState, DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { rm } from 'fs/promises';
import { io } from '../server.js';
import { ConversationService } from './conversation.service.js';
import { BotEngineService } from './botEngine.service.js';
import { AuthService } from './auth.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';

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

    const isGroup = remoteJid.endsWith('@g.us');
    const user = await AuthService.getUserById(userId);

    // Switch "Responder también en grupos" (PUT /api/whatsapp/bot-groups-enabled): por default
    // el bot solo atiende chats individuales, ignorando por completo los mensajes de grupo.
    if (isGroup && !user?.botGroupsEnabled) return;

    const text: string | undefined = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!text) return; // ignorar mensajes sin texto (imágenes, audios, etc.) por ahora

    // En un grupo, remoteJid es el grupo entero — quien realmente escribió está en
    // key.participant. Sin eso no hay a quién atribuirle el mensaje (pasa con algunos mensajes
    // de sistema del grupo), así que se ignora.
    const participantJid: string | undefined = isGroup ? msg.key?.participant : undefined;
    if (isGroup && !participantJid) return;

    let contactName: string = msg.pushName || remoteJid.split('@')[0];
    let phone: string;
    let groupName: string | null = null;

    if (isGroup && participantJid) {
      // Una conversación (con su propio historial) POR CADA PARTICIPANTE del grupo, no una sola
      // para todo el grupo — así el bot distingue de qué venía hablando cada persona en vez de
      // mezclar el contexto de todos los que escriben ahí. "phone" queda como
      // "<grupo>-<participante>" para que sea única por combinación. groupName queda guardado
      // en la conversación (ver ConversationService.listByGroupName) para que el panel pueda
      // encontrar a todos los participantes de este mismo grupo real, sin adivinar nada leyendo
      // la pantalla — ver AiSummaryModal.
      phone = `${remoteJid.split('@')[0]}-${participantJid.split('@')[0]}`;
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

    // Se pide ANTES de loguear el mensaje entrante actual: son los turnos previos de la
    // conversación, sin incluir todavía este mensaje (que se lo pasamos aparte a
    // processIncomingMessage como incomingText). Se filtra contra las bases ACTIVAS ahora mismo,
    // así una respuesta vieja generada con una base que ya se desactivó deja de "pesar" en la
    // charla — ver ConversationService.toAiHistory().
    const priorMessages = await ConversationService.getMessages(conversation.id);
    const activeBaseIds = await KnowledgeBaseService.getActiveBaseIds();
    const history = ConversationService.toAiHistory(priorMessages ?? [], activeBaseIds);

    const inbound = await ConversationService.addMessage(conversation.id, 'customer', text);
    if (inbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', inbound.message);
      io.emit('conversation_updated', inbound.conversation);
    }

    // Switch "Habilitar bot" del panel (PUT /api/whatsapp/bot-enabled): el mensaje del cliente
    // queda igual registrado en la conversación arriba, pero si está apagado no autorespondemos.
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

    // En grupos se responde siempre al grupo (WhatsApp no tiene "responder en privado" desde
    // ahí), pero se menciona a quien escribió para que quede claro a quién le está contestando
    // el bot en medio de la charla de todos.
    if (isGroup && participantJid) {
      await socket.sendMessage(remoteJid, {
        text: `@${participantJid.split('@')[0]} ${botResult.replyText}`,
        mentions: [participantJid],
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

    // Corre siempre, aunque no haya sesión en memoria: permite limpiar un estado ya roto desde
    // antes (ej. el backend se reinició de golpe con una sesión a medio conectar) sin necesidad
    // de que el usuario pase primero por connect().
    await clearSession(userId);

    if (session) {
      try {
        await session.socket.logout();
      } catch (err) {
        // Puede fallar si la conexión ya estaba caída del otro lado; igual ya limpiamos la sesión
        // y las credenciales en disco arriba.
        console.error(`⚠️ [WhatsApp] Error cerrando sesión del usuario ${userId}:`, err);
      }
    }

    emitStatus(userId, 'disconnected');
  }
}
