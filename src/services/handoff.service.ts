import type { WASocket } from '@whiskeysockets/baileys';
import { AdvisorService, Advisor } from './advisor.service.js';
import { BotContactService } from './botContact.service.js';
import { FlowEngineService } from './flowEngine.service.js';
import { FlowHandoffRequest } from '../types/flow.js';

// Ejecuta el bloque "Contactar Asesor" del editor visual de flujos: elige un asesor real (ver
// AdvisorService.pickNextAdvisor/getById) y lo notifica por WhatsApp desde la misma línea de la
// empresa. A propósito NO pausa al bot — el bot sigue respondiendo con total normalidad después
// de derivar; solo se reserva ese asesor por 30 minutos (ver AdvisorService.
// HANDOFF_RESERVATION_MINUTES) para no terminar derivando al mismo cliente a una segunda persona
// si vuelve a pedir un asesor antes de que el primero lo contacte.
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
   * HANDOFF y por la tool handoff_to_advisor (Issue #30 [BE-049]) — execute() solo reserva ese
   * asesor para esta conversación, sin volver a elegir/notificar/contar (eso duplicaría el mensaje
   * al asesor y el conteo del round-robin).
   */
  resolvedAdvisor?: Advisor;
}

export interface HandoffResult {
  advisor: Advisor | null;
  notified: boolean;
  /** true si NO se eligió un asesor nuevo porque esta conversación ya tenía uno reservado sin
   * vencer — whatsapp.service.ts usa esto para avisarle al cliente que ya tiene uno asignado, en
   * vez del mensaje normal de derivación. */
  alreadyPending?: boolean;
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
    // handoffConversation) — solo falta reservar ese asesor para esta conversación puntual.
    if (ctx.resolvedAdvisor) {
      try {
        await BotContactService.reserveHandoffAdvisor(ctx.userId, ctx.botContactJid, ctx.resolvedAdvisor.id, AdvisorService.HANDOFF_RESERVATION_MINUTES);
      } catch (err) {
        console.error('❌ [HandoffService] Error reservando el asesor para esta conversación:', err);
      }
      return { advisor: ctx.resolvedAdvisor, notified: true };
    }

    // La conversación ya tiene un asesor reservado sin vencer (ver AdvisorService.
    // getActiveHandoffAdvisor) — no se elige uno nuevo, se extiende la reserva del mismo para no
    // terminar derivando al mismo cliente a una SEGUNDA persona.
    try {
      const existing = await AdvisorService.getActiveHandoffAdvisor(ctx.userId, ctx.botContactJid);
      if (existing) {
        try {
          await BotContactService.reserveHandoffAdvisor(ctx.userId, ctx.botContactJid, existing.id, AdvisorService.HANDOFF_RESERVATION_MINUTES);
        } catch (err) {
          console.error('❌ [HandoffService] Error extendiendo la reserva del asesor:', err);
        }
        return { advisor: existing, notified: false, alreadyPending: true };
      }
    } catch (err) {
      console.error('❌ [HandoffService] Error chequeando si ya había un asesor asignado:', err);
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
      console.warn(
        `⚠️ [HandoffService] Ningún asesor activo para el usuario ${ctx.userId} (modo="${ctx.request.advisorMode}") — no hay a quién reservar.`
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
      await BotContactService.reserveHandoffAdvisor(ctx.userId, ctx.botContactJid, advisor.id, AdvisorService.HANDOFF_RESERVATION_MINUTES);
    } catch (err) {
      console.error('❌ [HandoffService] Error reservando el asesor para esta conversación:', err);
    }

    return { advisor, notified };
  }
}
