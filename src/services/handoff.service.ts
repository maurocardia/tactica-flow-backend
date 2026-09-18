import type { WASocket } from '@whiskeysockets/baileys';
import { AdvisorService, Advisor } from './advisor.service.js';
import { BotContactService } from './botContact.service.js';
import { FlowEngineService } from './flowEngine.service.js';
import { FlowHandoffRequest } from '../types/flow.js';

// Ejecuta el bloque "Contactar Asesor" del editor visual de flujos: elige un asesor real (ver
// AdvisorService.pickNextAdvisor/getById), lo notifica por WhatsApp desde la misma línea de la
// empresa, y pausa el bot para esta conversación puntual (ver bot_contacts.handoff_paused_until)
// hasta que el asesor la resuelva o venza el tiempo configurado.
//
// Vive separado de FlowEngineService/BotEngineService a propósito: esos servicios solo devuelven
// el INTENT de derivar (FlowHandoffRequest), sin resolver nada — la resolución necesita el
// `userId`, el `socket` de Baileys y el JID reales, que solo whatsapp.service.ts tiene a mano.

export interface HandoffContext {
  userId: number;
  socket: WASocket;
  /** JID tal cual vive en bot_contacts (grupo: el JID del grupo; individual: el JID canónico). */
  botContactJid: string;
  /** Clave de estado de FlowEngineService.userStates (mismo `phone` que arma handleIncomingMessage). */
  customerPhoneKey: string;
  /** Solo dígitos, para armar el link wa.me en la notificación al asesor. */
  customerPhoneDigits: string;
  customerName: string;
  isGroup: boolean;
  groupName?: string | null;
  lastMessageText: string;
  request: FlowHandoffRequest;
  /**
   * Cuando la derivación (elegir asesor + notificarlo con el resumen de IA + contar) ya se hizo
   * afuera de este servicio — ver AdvisorService.handoffConversation, usada por la regla legacy
   * HANDOFF y por la tool handoff_to_advisor (Issue #30 [BE-049]) — execute() solo pausa el bot
   * para esta conversación con el asesor ya resuelto, sin volver a elegir/notificar/contar (eso
   * duplicaría el mensaje al asesor y el conteo del round-robin).
   */
  resolvedAdvisor?: Advisor;
}

export interface HandoffResult {
  advisor: Advisor | null;
  notified: boolean;
}

const DEFAULT_NOTIFY_TEMPLATE = [
  '🔔 Nueva derivación · Tactica Flow',
  '',
  '👤 Cliente: {nombre}',
  '📱 Teléfono: {telefono}',
  '🕒 {fecha}',
  '',
  '💬 Último mensaje:',
  '"{mensaje}"',
  '',
  'Respondele directo: https://wa.me/{telefono}',
].join('\n');

export class HandoffService {
  static async execute(ctx: HandoffContext): Promise<HandoffResult> {
    // Derivación ya resuelta afuera (regla legacy HANDOFF / tool de IA, ver AdvisorService.
    // handoffConversation) — solo falta pausar el bot para esta conversación puntual.
    if (ctx.resolvedAdvisor) {
      try {
        await BotContactService.setHandoffPause(ctx.userId, ctx.botContactJid, ctx.resolvedAdvisor.id, ctx.request.pauseMinutes);
      } catch (err) {
        console.error('❌ [HandoffService] Error pausando el bot para esta conversación:', err);
      }
      FlowEngineService.clearUserState(ctx.customerPhoneKey);
      return { advisor: ctx.resolvedAdvisor, notified: true };
    }

    let advisor: Advisor | null = null;
    let alreadyCounted = false;
    try {
      if (ctx.request.advisorMode === 'fixed' && ctx.request.advisorId) {
        const fixed = await AdvisorService.getById(ctx.userId, ctx.request.advisorId);
        // Asesor fijo borrado o desactivado desde que se armó el flujo: se trata como "sin
        // asesor" en vez de fallar — ver el caso borde de abajo.
        advisor = fixed && fixed.isActive ? fixed : null;
      } else {
        // pickNextAdvisor ya cuenta la derivación de forma atómica al elegir — a diferencia del
        // modo "fijo" (getById no cuenta nada), no hace falta un recordHandoff aparte para este.
        advisor = await AdvisorService.pickNextAdvisor(ctx.userId);
        alreadyCounted = true;
      }
    } catch (err) {
      console.error('❌ [HandoffService] Error eligiendo asesor:', err);
    }

    if (!advisor) {
      // Sin nadie activo que atienda: NO se pausa el bot (dejaría al cliente en el vacío) — el
      // texto que el nodo HANDOFF ya haya mandado (si tenía replyText) es lo único que recibe.
      console.warn(
        `⚠️ [HandoffService] Ningún asesor activo para el usuario ${ctx.userId} (modo="${ctx.request.advisorMode}") — no se pausa el bot.`
      );
      return { advisor: null, notified: false };
    }

    if (!alreadyCounted) {
      try {
        await AdvisorService.recordHandoff(advisor.id);
      } catch (err) {
        console.error('❌ [HandoffService] Error registrando la derivación:', err);
      }
    }

    // Notificar al asesor es best-effort: si falla (número inválido, sin WhatsApp, etc.), el
    // cliente igual ya recibió (o va a recibir) la respuesta del flujo — nunca debe tumbar nada.
    let notified = false;
    try {
      const advisorDigits = advisor.phone.replace(/[^0-9]/g, '');
      const advisorJid = `${advisorDigits}@s.whatsapp.net`;
      const template = ctx.request.notifyTemplate?.trim() || DEFAULT_NOTIFY_TEMPLATE;
      const text = FlowEngineService.applyVariables(template, {
        nombre: ctx.isGroup ? `${ctx.customerName} (${ctx.groupName || 'grupo'})` : ctx.customerName,
        telefono: ctx.customerPhoneDigits,
        asesor: advisor.name,
        mensaje: ctx.lastMessageText,
        fecha: new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' } as any),
      });
      await ctx.socket.sendMessage(advisorJid, { text });
      notified = true;
    } catch (err) {
      console.error(`⚠️ [HandoffService] No se pudo notificar al asesor "${advisor.name}":`, err);
    }

    try {
      await BotContactService.setHandoffPause(ctx.userId, ctx.botContactJid, advisor.id, ctx.request.pauseMinutes);
    } catch (err) {
      console.error('❌ [HandoffService] Error pausando el bot para esta conversación:', err);
    }

    // Si el cliente estaba a mitad de un menú del flujo, esa posición queda descartada — al
    // reactivarse el bot (venza la pausa o lo reactive el panel) arranca limpio, no atascado en un
    // nodo viejo.
    FlowEngineService.clearUserState(ctx.customerPhoneKey);

    return { advisor, notified };
  }
}
