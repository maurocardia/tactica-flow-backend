import { makeWASocket, DisconnectReason, downloadMediaMessage, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { io } from '../server.js';
import { db } from '../config/db.js';
import { ConversationService } from './conversation.service.js';
import { BotContactService } from './botContact.service.js';
import { BotEngineService } from './botEngine.service.js';
import { AuthService } from './auth.service.js';
import { AIService } from './ai.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';
import { usePostgresAuthState } from './postgresAuthState.js';
import { FlowMediaService } from './flowMedia.service.js';
import { HandoffService } from './handoff.service.js';
import { FlowEngineService } from './flowEngine.service.js';
import { FlowOutboundMessage } from '../types/flow.js';

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

// Baileys puede re-emitir 'messages.upsert' más de una vez para el mismo mensaje (sobre todo
// durante reconexiones inestables, ver conflict/replaced en los logs) — sin esto, el mismo
// mensaje del cliente dispara dos respuestas de IA distintas para la misma pregunta (la segunda
// ve la primera en su propio historial y termina mezclando temas). Set en memoria por proceso,
// con tope de tamaño para no crecer indefinidamente en una sesión larga.
const seenMessageIds = new Set<string>();
const MAX_SEEN_MESSAGE_IDS = 2000;

function isDuplicateMessage(userId: number, msgId: string | null | undefined): boolean {
  if (!msgId) return false;
  const key = `${userId}:${msgId}`;
  if (seenMessageIds.has(key)) return true;
  seenMessageIds.add(key);
  if (seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = seenMessageIds.values().next().value;
    if (oldest !== undefined) seenMessageIds.delete(oldest);
  }
  return false;
}

// Nombre guardado en la agenda del teléfono (sincronizado por Baileys vía eventos
// 'contacts.upsert'/'contacts.update'), distinto del "pushName" que manda cada mensaje (el
// nombre que ESA persona se puso a sí misma en WhatsApp, no como vos la tenés guardada). Se
// prefiere este nombre para mostrar en el panel — ver getSavedContactName() y su uso en
// handleIncomingMessage. En memoria por usuario, se repuebla solo con lo que Baileys sincronice
// en esta sesión (no persiste entre reinicios del backend, pero sí se guarda en la conversación
// ya creada apenas se conoce).
const savedContactNames = new Map<number, Map<string, string>>();
// JID completo (con dominio real, @s.whatsapp.net o @lid) más reciente que Baileys reportó para
// cada contacto conocido — savedContactNames guarda solo la parte local (sin dominio) a propósito
// para que un mensaje disparado desde cualquier variante de JID encuentre el mismo nombre, pero
// para dar de alta una fila nueva en bot_contacts (ver WhatsappService.syncBotContacts) hace falta
// el JID completo.
const savedContactJids = new Map<number, Map<string, string>>();

function getSavedContactName(userId: number, jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  return savedContactNames.get(userId)?.get(jid.split('@')[0]);
}

function setSavedContactName(userId: number, jid: string, name: string) {
  const map = savedContactNames.get(userId) || new Map<string, string>();
  map.set(jid.split('@')[0], name);
  savedContactNames.set(userId, map);

  const jidMap = savedContactJids.get(userId) || new Map<string, string>();
  jidMap.set(jid.split('@')[0], jid);
  savedContactJids.set(userId, jidMap);
}

function emitStatus(userId: number, status: WhatsappConnectionStatus) {
  io.emit('whatsapp_status_updated', { userId, status });
}

// Justo después de conectar (o reconectar), Baileys arranca una sincronización pesada del
// historial (descarga chats/contactos/mensajes viejos, ver logs "got history notification").
// Si en ese mismo momento llega un mensaje real y el bot intenta responder, el socket puede
// estar saturado con esa sincronización y la consulta interna de sendMessage (USync, para
// resolver los dispositivos del destinatario) tira "Timed Out" (408) aunque la conexión en sí
// esté sana. Reintentamos un par de veces con una pequeña espera en vez de perder la respuesta.
function isTransientSendError(error: unknown): boolean {
  const err = error as { output?: { statusCode?: number }; message?: string } | undefined;
  const statusCode = err?.output?.statusCode;
  if (statusCode === 408 || statusCode === 429 || (statusCode ?? 0) >= 500) return true;
  return /timed out|timeout|econnreset|econnrefused|etimedout/i.test(err?.message || '');
}

async function sendWithRetry(
  socket: WASocket,
  jid: string,
  content: Parameters<WASocket['sendMessage']>[1],
  maxRetries = 2
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await socket.sendMessage(jid, content);
      return;
    } catch (error) {
      if (attempt < maxRetries && isTransientSendError(error)) {
        const delayMs = 2000 * (attempt + 1);
        console.warn(`⏳ [WhatsApp] Timeout enviando a ${jid} (intento ${attempt + 1}/${maxRetries + 1}), reintentando en ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
}

// Arma el `content` real de Baileys para un mensaje de tipo 'media' del flujo — carga los bytes
// desde flow_media_assets (adjunto subido) o pasa la URL tal cual (adjunto por URL, sin infra
// propia). Devuelve null si el nodo quedó mal configurado (sin adjunto todavía), para que el
// llamador decida cómo degradar en vez de reventar el envío.
async function resolveMediaContent(
  userId: number,
  message: Extract<FlowOutboundMessage, { kind: 'media' }>
): Promise<Parameters<WASocket['sendMessage']>[1] | null> {
  let uploadSource: Buffer | { url: string } | null = null;
  let mimeType = message.mimeType;
  let fileName = message.fileName;

  if (message.source === 'upload' && message.assetId) {
    const asset = await FlowMediaService.getByIdWithData(userId, message.assetId);
    if (!asset) return null;
    uploadSource = asset.data;
    mimeType = asset.mimeType;
    fileName = asset.fileName;
  } else if (message.source === 'url' && message.url) {
    uploadSource = { url: message.url };
  }
  if (!uploadSource) return null;

  switch (message.mediaKind) {
    case 'image':
      return { image: uploadSource, caption: message.caption };
    case 'video':
      return { video: uploadSource, caption: message.caption, gifPlayback: message.gifPlayback };
    case 'audio':
      // Baileys/WhatsApp no soporta `caption` en audio — FlowEngineService ya manda el texto del
      // nodo como mensaje aparte antes de este, ver buildNodeChain.
      return { audio: uploadSource, ptt: message.ptt };
    case 'document':
      return {
        document: uploadSource,
        mimetype: mimeType || 'application/octet-stream',
        fileName: fileName || 'documento',
        caption: message.caption
      };
    default:
      return null;
  }
}

// Manda la lista de mensajes que armó el flujo (texto/media/delay), en orden — reemplaza el envío
// de un único `{ text }` fijo que había antes. La mención "@fulano" de grupos va solo en el
// PRIMER mensaje de texto (antes solo había uno, así que no cambia el comportamiento existente).
async function sendFlowMessages(
  userId: number,
  socket: WASocket,
  remoteJid: string,
  messages: FlowOutboundMessage[],
  opts: { isGroup: boolean; participantJid?: string }
): Promise<void> {
  let mentionedFirstText = false;

  for (const message of messages) {
    if (message.kind === 'delay') {
      const seconds = Math.min(Math.max(message.seconds, 0), 30);
      try {
        await socket.sendPresenceUpdate('composing', remoteJid);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      try {
        await socket.sendPresenceUpdate('paused', remoteJid);
      } catch {}
      continue;
    }

    if (message.kind === 'text') {
      if (opts.isGroup && opts.participantJid && !mentionedFirstText) {
        mentionedFirstText = true;
        await sendWithRetry(socket, remoteJid, {
          text: `@${opts.participantJid.split('@')[0]} ${message.text}`,
          mentions: [opts.participantJid]
        });
      } else {
        await sendWithRetry(socket, remoteJid, { text: message.text });
      }
      continue;
    }

    // message.kind === 'media' — si falla resolver o mandar el adjunto, degrada a texto en vez de
    // cortar el resto de la cadena de mensajes.
    try {
      const mediaContent = await resolveMediaContent(userId, message);
      if (!mediaContent) throw new Error('El nodo no tiene un adjunto configurado.');
      await sendWithRetry(socket, remoteJid, mediaContent);
    } catch (err) {
      console.error(`⚠️ [WhatsApp] No se pudo enviar el adjunto (${message.mediaKind}), se degrada a texto:`, err);
      const fallbackText = message.caption || `[No se pudo enviar el adjunto: ${message.fileName || message.mediaKind}]`;
      await sendWithRetry(socket, remoteJid, { text: fallbackText });
    }
  }
}

// Bloques interactivos del editor de flujos (Menú/Respuestas/Lista) pueden configurar un "tiempo
// de espera" — si el cliente no responde a tiempo, FlowEngineService arma un temporizador real y
// llama acá para mandarle el mensaje de "sin respuesta" por su cuenta, sin que haya escrito nada
// (ver flowEngine.service.ts: scheduleTimeout / setProactiveSender). Se registra una sola vez acá
// porque este es el único módulo con acceso a `sessions` (el socket real de Baileys).
FlowEngineService.setProactiveSender(async (ctx) => {
  const session = sessions.get(ctx.userId);
  if (!session || session.status !== 'connected') return;

  // Mismo chequeo que handleIncomingMessage antes de responder — si el usuario bloqueó al
  // contacto, apagó el bot, o sigue en una pausa de handoff DESDE que se armó este temporizador,
  // no corresponde mandarle nada igual.
  const gating = await BotContactService.getGatingFlags(ctx.userId, ctx.botContactJid);
  if (gating.isBlacklisted) return;
  if (gating.handoffPausedUntil && gating.handoffPausedUntil > new Date()) return;
  const user = await AuthService.getUserById(ctx.userId);
  if (!user?.botEnabled) return;
  if (!user.botReplyToAll && !gating.botEnabled) return;

  await sendFlowMessages(ctx.userId, session.socket, ctx.remoteJid, ctx.messages, {
    isGroup: ctx.isGroup,
    participantJid: ctx.participantJid
  });

  const conversation = await ConversationService.findOrCreateByPhone(ctx.phone, ctx.contactName, ctx.userId, ctx.groupName ?? null);
  const replyText = ctx.messages
    .filter((m): m is Extract<FlowOutboundMessage, { kind: 'text' }> => m.kind === 'text')
    .map((m) => m.text)
    .join('\n\n');
  const outbound = await ConversationService.addMessage(conversation.id, 'bot', replyText, []);
  if (outbound) {
    io.to(`chat_${conversation.id}`).emit('new_message', outbound.message);
    io.emit('conversation_updated', outbound.conversation);
  }
});

const connectingPromises = new Map<number, Promise<{ status: WhatsappConnectionStatus }>>();

export class WhatsappService {
  static getStatus(userId: number): WhatsappConnectionStatus {
    return sessions.get(userId)?.status ?? (connectingPromises.has(userId) ? 'connecting' : 'disconnected');
  }

  static async getStatusAsync(userId: number): Promise<WhatsappConnectionStatus> {
    const session = sessions.get(userId);
    if (session) return session.status;
    if (connectingPromises.has(userId)) return 'connecting';

    try {
      const { rows } = await db.query(
        "SELECT data FROM whatsapp_sessions WHERE user_id = $1 AND key_id = 'creds'",
        [userId]
      );
      if (rows.length > 0) {
        WhatsappService.connect(userId).catch((err) =>
          console.warn(`[WhatsApp] Auto-connect on getStatus failed for user ${userId}:`, err)
        );
        return 'connecting';
      }
    } catch (e) {
      console.warn('[WhatsApp] Error consultando creds en getStatus:', e);
    }
    return 'disconnected';
  }

  static getOwnerJid(userId: number): string | null {
    const session = sessions.get(userId);
    if (session?.socket?.user?.id) {
      return session.socket.user.id.split(':')[0] + '@s.whatsapp.net';
    }
    return null;
  }

  static getQr(userId: number): string | null {
    return sessions.get(userId)?.qrDataUrl ?? null;
  }

  /**
   * Sincronización manual "de una vez" de bot_contacts, pensada para dispararse al abrir el panel
   * "Bot habilitado por contacto" (no en cada apertura — el frontend la llama una sola vez por
   * sesión y después solo vuelve a pedir la lista normal). Solo sincroniza GRUPOS
   * (groupFetchAllParticipating es una API real y confiable de Baileys, un grupo no puede salir
   * mal identificado). Los contactos individuales NO se siembran acá de forma independiente: a
   * diferencia de los grupos, un backfill "a ciegas" desde `conversations` o desde los nombres que
   * Baileys va aprendiendo puede inyectar basura (filas viejas de la fragmentación por @lid sin
   * nombre real, mostrando el número crudo como si fuera el nombre). La lista de contactos
   * individuales la manda el DOM de WhatsApp Web (siempre coherente, es lo que ve un humano) — ver
   * DOMService.getRecentIndividualContacts y ContactBotSwitchesModal.syncRecentFromDom — y el
   * backend solo completa el JID real de esos nombres puntuales cuando se lo piden
   * (resolveContactsByName), nunca al revés.
   */
  static async syncBotContacts(userId: number): Promise<{ groupsSynced: number }> {
    const session = sessions.get(userId);
    if (!session || session.status !== 'connected') {
      throw new Error('No hay una sesión de WhatsApp conectada para este usuario');
    }

    let groupsSynced = 0;
    try {
      const groups = await session.socket.groupFetchAllParticipating();
      for (const [jid, metadata] of Object.entries(groups)) {
        await BotContactService.seedIfMissing(userId, jid, metadata.subject || jid.split('@')[0], true);
        groupsSynced++;
      }
    } catch (err) {
      console.error(`⚠️ [WhatsApp] Error sincronizando grupos (sync manual) para usuario ${userId}:`, err);
    }

    return { groupsSynced };
  }

  /**
   * Intenta resolver el JID real de una lista de NOMBRES tal cual los muestra WhatsApp (ej. los
   * que ya están renderizados en la lista de chats — ver DOMService.getRecentIndividualContacts en
   * el frontend). No hace ninguna llamada a WhatsApp: solo cruza contra dos fuentes que el backend
   * ya tiene sin costo — (1) los nombres que Baileys le avisó a esta sesión por 'contacts.upsert'/
   * 'contacts.update' (el mismo mapa que usa syncBotContacts) y (2) `conversations`, con el mismo
   * criterio de "parece un teléfono real" que el backfill normal. Para un nombre que no aparece en
   * ninguna de las dos, no hay forma de sacar su JID sin abrir ese chat puntual en WhatsApp Web
   * (ver ContactBotSwitchesModal.handleAddContact) — WhatsApp no expone un "buscá por nombre" del
   * lado del dispositivo vinculado.
   */
  static async resolveContactsByName(
    userId: number,
    rawNames: string[]
  ): Promise<{ name: string; jid: string | null; source: 'known-contact' | 'conversations' | 'unresolved' }[]> {
    const names = savedContactNames.get(userId);
    const jids = savedContactJids.get(userId);

    const nameToJid = new Map<string, string>();
    if (names && jids) {
      for (const [localPart, name] of names) {
        const jid = jids.get(localPart);
        if (jid) nameToJid.set(name.trim().toLowerCase(), jid);
      }
    }

    const results: { name: string; jid: string | null; source: 'known-contact' | 'conversations' | 'unresolved' }[] = [];
    for (const rawName of rawNames) {
      const name = rawName.trim();
      if (!name) continue;
      const key = name.toLowerCase();

      const knownJid = nameToJid.get(key);
      if (knownJid) {
        results.push({ name, jid: knownJid, source: 'known-contact' });
        continue;
      }

      const { rows } = await db.query(
        `SELECT phone FROM conversations
         WHERE user_id = $1 AND group_name IS NULL AND phone ~ '^[0-9]{8,13}$' AND lower(name) = lower($2)
         ORDER BY last_message_at DESC LIMIT 1`,
        [userId, name]
      );
      if (rows.length > 0) {
        results.push({ name, jid: `${rows[0].phone}@s.whatsapp.net`, source: 'conversations' });
        continue;
      }

      results.push({ name, jid: null, source: 'unresolved' });
    }

    return results;
  }

  static async connect(userId: number): Promise<{ status: WhatsappConnectionStatus }> {
    const existing = sessions.get(userId);
    if (existing) {
      return { status: existing.status };
    }

    const inProgress = connectingPromises.get(userId);
    if (inProgress) {
      return inProgress;
    }

    const connectPromise = (async () => {
      try {
        const { state, saveCreds, clearCreds } = await usePostgresAuthState(userId);
        const socket = makeWASocket({
          auth: state,
          printQRInTerminal: false,
          defaultQueryTimeoutMs: 90000
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
            try {
              await saveCreds();
            } catch (saveErr) {
              console.warn('[WhatsApp] Error guardando creds en connection.open:', saveErr);
            }
            session.status = 'connected';
            session.qrDataUrl = null;
            emitStatus(userId, 'connected');
            console.log(`✅ [WhatsApp] Sesión conectada y lista para el usuario ${userId}`);

            try {
              const groups = await socket.groupFetchAllParticipating();
              for (const [jid, metadata] of Object.entries(groups)) {
                await BotContactService.seedIfMissing(userId, jid, metadata.subject || jid.split('@')[0], true);
              }
              console.log(`🔄 [WhatsApp] ${Object.keys(groups).length} grupo(s) sincronizado(s) en bot_contacts para usuario ${userId}.`);
            } catch (err) {
              console.error(`⚠️ [WhatsApp] Error sincronizando grupos en bot_contacts para usuario ${userId}:`, err);
            }
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
              ?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

            try {
              socket.ev.removeAllListeners('connection.update');
              socket.ev.removeAllListeners('creds.update');
              socket.ev.removeAllListeners('messages.upsert');
            } catch (e) {}

            sessions.delete(userId);
            emitStatus(userId, 'disconnected');

            if (loggedOut) {
              console.warn(`🔒 [WhatsApp] Sesión cerrada desde el teléfono para usuario ${userId}`);
              await clearCreds();
              return;
            }

            if (isReplaced) {
              console.warn(`⚠️ [WhatsApp] Sesión de usuario ${userId} reemplazada por otra instancia activa (440). Pausando auto-reconexión para evitar conflicto en bucle.`);
              return;
            }

            console.log(`🔄 [WhatsApp] Reconectando sesión de usuario ${userId} en 5 segundos... (código ${statusCode || 'desconocido'})`);
            setTimeout(() => {
              WhatsappService.connect(userId).catch((err) => {
                console.error(`❌ [WhatsApp] Error reconectando sesión de usuario ${userId}:`, err);
              });
            }, 5000);
          }
        });

    // Sincroniza los nombres reales guardados en la agenda del teléfono (no el pushName que cada
    // quien se pone a sí mismo) — ver savedContactNames arriba. Estos eventos los dispara Baileys
    // con lo que WhatsApp le vaya mandando de la agenda, aunque el history sync completo esté
    // apagado; puede tardar en poblarse o, para algunos contactos, no llegar nunca (WhatsApp no
    // siempre comparte el nombre guardado del otro lado).
    const onContactNames = (contacts: { id: string; name?: string }[]) => {
      for (const c of contacts) {
        if (c.name && !c.id.endsWith('@g.us')) {
          setSavedContactName(userId, c.id, c.name);
          ConversationService.updateNameIfKnown(c.id.split('@')[0], userId, c.name).catch((err: unknown) => {
            console.error(`⚠️ [WhatsApp] Error actualizando nombre guardado de ${c.id}:`, err);
          });
          // seedIfMissing en vez de solo actualizar el nombre: si es un contacto de la agenda que
          // todavía no escribió al bot, esto lo agrega a la lista igual (al fondo, por actividad —
          // ver comentario de seedIfMissing) en vez de esperar a que mande un mensaje real.
          BotContactService.seedIfMissing(userId, c.id, c.name, false).catch((err: unknown) => {
            console.error(`⚠️ [WhatsApp] Error agregando/actualizando en bot_contacts a ${c.id}:`, err);
          });
        }
      }
    };
    socket.ev.on('contacts.upsert', onContactNames);
    socket.ev.on('contacts.update', (updates) => onContactNames(updates.filter((u): u is { id: string; name?: string } => !!u.id)));

    // "Sincronización rápida" (Issue: lista de contactos con orden/nombres desactualizados):
    // Baileys manda esto una sola vez apenas conecta (gracias a syncFullHistory arriba), con los
    // chats y contactos reales de WhatsApp — incluye gente que nunca le escribió al bot todavía.
    // Lo usamos para crear/actualizar esas conversaciones con su nombre y fecha de actividad
    // reales, así "Bot habilitado por contacto" refleja el orden verdadero de WhatsApp. Ver
    // ConversationService.upsertFromSync. Los grupos (@g.us) se dejan afuera acá: sus filas se
    // arman por participante cuando escriben de verdad (ver handleIncomingMessage).
    socket.ev.on('messaging-history.set', ({ chats, contacts }) => {
      (async () => {
        try {
          const nameByJid = new Map<string, string>();
          for (const c of contacts) {
            if (c.id && c.name) {
              nameByJid.set(c.id, c.name);
              setSavedContactName(userId, c.id, c.name);
            }
          }

          let synced = 0;
          for (const chat of chats) {
            if (!chat.id || chat.id.endsWith('@g.us') || chat.id.endsWith('@broadcast')) continue;
            const jidLocal = chat.id.split('@')[0];
            const name = nameByJid.get(chat.id) || (chat as { name?: string }).name || jidLocal;
            const ts = chat.conversationTimestamp ? new Date(Number(chat.conversationTimestamp) * 1000) : new Date();
            await ConversationService.upsertFromSync(userId, jidLocal, name, ts);
            synced++;
          }
          console.log(`🔄 [WhatsApp] Sincronización rápida completa para usuario ${userId}: ${contacts.length} contactos, ${synced} chats.`);
        } catch (err) {
          console.error(`⚠️ [WhatsApp] Error en la sincronización rápida para usuario ${userId}:`, err);
        }
      })();
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (isDuplicateMessage(userId, msg.key?.id)) {
          console.warn(`⚠️ [WhatsApp] Mensaje duplicado ignorado (id=${msg.key?.id}), usuario ${userId}.`);
          continue;
        }
        try {
          await WhatsappService.handleIncomingMessage(userId, socket, msg);
        } catch (err) {
          console.error(`❌ [WhatsApp] Error procesando mensaje entrante (usuario ${userId}):`, err);
        }
      }
    });

    return { status: session.status };
  } catch (err) {
    connectingPromises.delete(userId);
    throw err;
  } finally {
    connectingPromises.delete(userId);
  }
})();

connectingPromises.set(userId, connectPromise);
return connectPromise;
  }

  private static async handleIncomingMessage(userId: number, socket: WASocket, msg: any): Promise<void> {
    const remoteJid: string | undefined = msg.key?.remoteJid;
    if (!remoteJid) return;
    // Canales de WhatsApp (Newsletters, @newsletter) y difusiones de estado (@broadcast) no son
    // contactos reales de dos vías — sin este filtro, un canal al que estás suscripto se cuela acá
    // como si fuera un chat individual, con el número interno del canal como "nombre" (confirmado:
    // terminó una fila así en bot_contacts, ver id 6107).
    if (remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@broadcast')) return;
    const fromMe = !!msg.key?.fromMe;

    const isGroup = remoteJid.endsWith('@g.us');
    const user = await AuthService.getUserById(userId);

    // buttonsResponseMessage/listResponseMessage: hoy el flujo nunca manda botones/lista NATIVOS
    // (Baileys 6.7.24 no tiene cómo — ver renderInteractiveAsText en flowEngine.service.ts, que en
    // cambio simula "Respuestas"/"Enviar Lista" como texto numerado), pero se extraen igual de
    // forma defensiva por si alguna vez llega una respuesta de ese tipo desde otra fuente.
    let text: string | undefined =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      msg.message?.listResponseMessage?.title ||
      msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;

    // Detectar y transcribir notas de voz o audios entrantes de WhatsApp con Baileys + Gemini
    const audioMessage = msg.message?.audioMessage;
    if (!text && audioMessage) {
      try {
        console.log(`🎙️ [WhatsApp] Descargando nota de voz (${audioMessage.seconds || 0}s) con Baileys...`);
        // NOTA: No pasamos reuploadRequest porque socket.updateMediaMessage no siempre existe
        // en todas las versiones de Baileys y causa crash. El download directo es suficiente.
        const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
        if (audioBuffer && (audioBuffer as Buffer).length > 0) {
          const transcription = await AIService.transcribeAudio(
            audioBuffer as Buffer,
            audioMessage.mimetype || 'audio/ogg; codecs=opus'
          );
          text = `[🎙️ Audio]: "${transcription}"`;
          console.log(`✅ [WhatsApp] Nota de voz transcripta: "${transcription}"`);
        } else {
          console.warn('⚠️ [WhatsApp] Buffer de audio vacío, no se puede transcribir.');
          text = `[🎙️ Nota de voz (${audioMessage.seconds || 0}s)]`;
        }
      } catch (audioErr: any) {
        console.error('⚠️ [WhatsApp] Error transcribiendo audio con Baileys/Gemini:', audioErr?.message || audioErr);
        text = `[🎙️ Nota de voz (${audioMessage.seconds || 0}s)]`;
      }
    }

    if (!text) return;

    // WhatsApp a veces etiqueta el mismo mensaje con un identificador "@lid" (linked ID) en vez
    // del número de teléfono real, y ese @lid puede ir ROTANDO entre sesiones — sin esto, cada
    // vez que a alguien le tocaba un @lid distinto, se creaba una conversación nueva para la
    // misma persona real (confirmado: un solo contacto real llegó a tener 13 filas separadas).
    // Baileys ya resuelve el equivalente en formato de teléfono en `participantPn`/`senderPn`
    // cuando lo sabe — preferimos siempre esa forma canónica.
    const participantJid: string | undefined = isGroup ? msg.key?.participantPn || msg.key?.participant : undefined;
    if (isGroup && !participantJid && !fromMe) return;

    const canonicalIndividualJid: string | undefined = !isGroup ? msg.key?.senderPn || remoteJid : undefined;
    const senderJid = isGroup ? participantJid : canonicalIndividualJid;

    // Preferimos el nombre real guardado en la agenda (si Baileys ya lo sincronizó) por sobre el
    // "pushName" que la propia persona se puso en WhatsApp — ver savedContactNames arriba.
    let contactName: string = getSavedContactName(userId, senderJid) || msg.pushName || (senderJid || remoteJid).split('@')[0];
    // Copia SIN el sufijo "· nombre del grupo" que se le agrega más abajo — para variables como
    // "{nombre}" en los mensajes del flujo (ver flowEngine.service.ts) queremos solo el nombre de
    // la persona, no "Juan · Grupo Ventas".
    const plainContactName = contactName;
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
      phone = (canonicalIndividualJid || remoteJid).split('@')[0];
    }

    const conversation = await ConversationService.findOrCreateByPhone(phone, contactName, userId, groupName);

    // Espejo liviano para el panel "Bot habilitado por contacto" (tabla bot_contacts, separada
    // de "conversations"/"messages" a propósito — ver comentario en db.ts). Un grupo es UNA sola
    // fila acá (jid = el JID del grupo en sí), no una por participante. Se actualiza siempre,
    // tanto para mensajes entrantes como para los que mandás vos (fromMe), así la fecha de
    // actividad y el nombre quedan al día sin importar quién escribió.
    const botContactJid = isGroup ? remoteJid : (canonicalIndividualJid || remoteJid);
    const botContactName = isGroup ? (groupName || remoteJid.split('@')[0]) : contactName;
    BotContactService.upsert(userId, botContactJid, botContactName, isGroup, new Date(), user?.botEnabledForNewContacts ?? false).catch((err) => {
      console.error(`⚠️ [WhatsApp] Error sincronizando bot_contacts para ${botContactJid}:`, err);
    });

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

    // Una sola consulta con todo lo que hace falta chequear antes de dejar responder al bot (ver
    // BotContactService.getGatingFlags) — evita sumar un tercer round-trip por mensaje solo para
    // la pausa por handoff.
    const gating = await BotContactService.getGatingFlags(userId, botContactJid);

    // Blacklist: gana por encima de CUALQUIER otro switch (Responder a todos, bot habilitado,
    // modo de respuesta, etc.) — un contacto en esta lista nunca recibe respuesta del bot, sin
    // excepción. Por eso se chequea primero, antes que nada más.
    if (gating.isBlacklisted) return;

    // Pausa por derivación a un asesor humano (bloque "Contactar Asesor" del flujo) — mientras
    // esté pausado, el bot no le responde a este contacto puntual, sin importar ningún otro
    // switch, hasta que venza el tiempo configurado o se reactive a mano desde el panel.
    if (gating.handoffPausedUntil && gating.handoffPausedUntil > new Date()) return;

    if (!user?.botEnabled) return;

    // "Responder a todos" vs "Responder a contactos seleccionados": con el modo "todos" activado
    // se salta el switch por contacto y le responde a cualquiera; si no, sigue el comportamiento
    // de siempre — el switch vive en bot_contacts (no en conversations), arranca apagado para
    // contactos nuevos (salvo que "Activar bot para contactos nuevos" esté prendido) y queda
    // guardado tal cual entre sesiones de Baileys (no se resetea solo).
    if (!user.botReplyToAll && !gating.botEnabled) return;

    const botResult = await BotEngineService.processIncomingMessage(
      text,
      phone,
      history,
      {},
      user.aiFallbackEnabled,
      user.aiCustomInstructions,
      user.aiProvider,
      user.aiModel,
      plainContactName,
      user.botMode,
      {
        userId,
        remoteJid,
        botContactJid,
        phone,
        isGroup,
        participantJid,
        contactName: plainContactName,
        groupName
      },
      userId
    );
    if (!botResult) return;

    // "Delay humanizado": espera un tiempo aleatorio entre min/max antes de mandar la respuesta,
    // para que no se sienta instantánea/robótica — ver ChatbotModule.tsx (sección "replyDelay").
    if (user.botReplyDelayEnabled) {
      const min = Math.min(user.botReplyDelayMinMs, user.botReplyDelayMaxMs);
      const max = Math.max(user.botReplyDelayMinMs, user.botReplyDelayMaxMs);
      const delayMs = min + Math.random() * (max - min);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    await sendFlowMessages(userId, socket, remoteJid, botResult.messages, { isGroup, participantJid });

    try {
      if (msg.key) {
        await socket.readMessages([msg.key]);
      }
    } catch {}

    const outbound = await ConversationService.addMessage(conversation.id, 'bot', botResult.replyText, botResult.sourceKbIds);
    if (outbound) {
      io.to(`chat_${conversation.id}`).emit('new_message', outbound.message);
      io.emit('conversation_updated', outbound.conversation);
    }

    // Bloque "Contactar Asesor" del flujo: elige/notifica al asesor y pausa el bot para esta
    // conversación puntual — ver HandoffService. Va DESPUÉS de mandar la respuesta al cliente
    // (nunca debe demorarla ni impedirla si algo acá falla).
    if (botResult.handoff) {
      try {
        const customerPhoneDigits = isGroup ? (participantJid ? participantJid.split('@')[0] : phone) : phone;
        const handoffResult = await HandoffService.execute({
          userId,
          socket,
          botContactJid,
          customerPhoneKey: phone,
          customerPhoneDigits,
          customerName: plainContactName,
          isGroup,
          groupName,
          lastMessageText: text,
          request: botResult.handoff,
          resolvedAdvisor: botResult.resolvedAdvisor
        });
        console.log(
          handoffResult.advisor
            ? `🔀 [WhatsApp] Conversación derivada a "${handoffResult.advisor.name}" (asesor notificado=${handoffResult.notified}).`
            : '⚠️ [WhatsApp] Se pidió derivar a un asesor pero no hay ninguno activo — no se pausó el bot.'
        );
      } catch (err) {
        console.error('❌ [WhatsApp] Error ejecutando la derivación a asesor:', err);
      }
    }
  }

  static async disconnect(userId: number): Promise<void> {
    const session = sessions.get(userId);
    if (session) {
      try {
        await session.socket.logout();
      } catch (err) {
        console.error(`🔴 [WhatsApp] Error cerrando el socket (logout) del usuario ${userId}:`, err);
      }
    }

    sessions.delete(userId);
    try {
      const { clearCreds } = await usePostgresAuthState(userId);
      await clearCreds();
    } catch (err) {
      console.error(`🔴 [WhatsApp] Error limpiando credenciales o contactos para ${userId}:`, err);
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

    let jid: string;
    if (phone.includes('@')) {
      jid = phone;
    } else if (phone.includes('-') && phone.startsWith('120363')) {
      jid = `${phone.split('-')[0]}@g.us`;
    } else if (phone.startsWith('120363')) {
      jid = `${phone}@g.us`;
    } else {
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      jid = `${cleanPhone}@s.whatsapp.net`;
    }
    await sendWithRetry(targetSession.socket, jid, { text });
    return true;
  }

  /**
   * Intenta descargar y transcribir un audio a demanda usando Baileys por su clave de mensaje o ID directo.
   */
  static async transcribeAudioByDataId(userId: number, dataId: string, phone?: string): Promise<string> {
    console.log(`🎙️ [WhatsApp Backend] Intentando transcribir audio por dataId "${dataId}" (usuario ${userId}, phone=${phone || 'n/a'})...`);

    // 1. Si ya existe en la base de datos de mensajes persistidos por Baileys
    if (dataId.startsWith('db_audio_')) {
      const msgId = parseInt(dataId.replace('db_audio_', ''), 10);
      const { rows } = await db.query('SELECT text FROM conversation_messages WHERE id = $1', [msgId]);
      if (rows.length > 0) {
        const match = rows[0].text.match(/\[🎙️ Audio\]:\s*"?(.*?)"?$/);
        if (match && match[1]) return match[1];
      }
    }

    // 2. Si hay sesión de Baileys conectada
    const session = sessions.get(userId);
    if (!session || session.status !== 'connected') {
      throw new Error('La sesión de WhatsApp no está conectada en el servidor. Dale Play al audio en WhatsApp Web para procesarlo con el navegador.');
    }

    let fromMe = false;
    let remoteJid: string = '';
    let messageId: string = dataId;

    const parts = dataId.split('_');
    if (parts.length >= 3) {
      fromMe = parts[0] === 'true';
      remoteJid = parts[1];
      if (remoteJid.endsWith('@c.us')) {
        remoteJid = remoteJid.replace('@c.us', '@s.whatsapp.net');
      }
      messageId = parts.slice(2).join('_');
    } else {
      if (phone) {
        const clean = phone.replace(/[^0-9]/g, '');
        remoteJid = `${clean}@s.whatsapp.net`;
      } else {
        const { rows } = await db.query(
          'SELECT phone FROM conversations WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 1',
          [userId]
        );
        if (rows.length > 0 && rows[0].phone) {
          remoteJid = `${rows[0].phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        }
      }
    }

    if (!remoteJid) {
      throw new Error(`No se pudo determinar el chat para el audio ID "${dataId}". Por favor dale Play en WhatsApp Web y reintenta.`);
    }

    console.log(`🔍 [WhatsApp Backend] Descargando mensaje multimedia en Baileys: remoteJid=${remoteJid}, id=${messageId}`);

    for (const testFromMe of [fromMe, !fromMe]) {
      try {
        const msgStub = {
          key: {
            remoteJid,
            fromMe: testFromMe,
            id: messageId
          }
        };
        const audioBuffer = await downloadMediaMessage(msgStub as any, 'buffer', {});
        if (audioBuffer && (audioBuffer as Buffer).length > 0) {
          const transcription = await AIService.transcribeAudio(audioBuffer as Buffer, 'audio/ogg; codecs=opus');
          console.log(`✅ [WhatsApp Backend] Audio transcripto con éxito vía Baileys: "${transcription}"`);
          return transcription;
        }
      } catch (baileysErr: any) {
        console.warn(`⚠️ [WhatsApp Backend] downloadMediaMessage intento con fromMe=${testFromMe} (${messageId}):`, baileysErr?.message || baileysErr);
      }
    }

    throw new Error(`Baileys no encontró el archivo descargable de este audio en los servidores de WhatsApp. Por favor dale Play en WhatsApp Web y reintenta.`);
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
