import { db } from '../config/db.js';
import { looksLikePhoneDigits } from '../utils/whatsappIdentity.js';

// Asesores humanos (panel: botón "Asesores" en ChatbotModule.tsx, AdvisorManagerModal.tsx) — a
// quién deriva el bot una conversación cuando decide que necesita intervención de una persona.
// Tabla propia y separada de bot_contacts/conversations: un asesor no es un contacto de WhatsApp
// administrable, es parte del equipo que RECIBE derivaciones.
export interface Advisor {
  id: number;
  userId: number;
  name: string;
  phone: string;
  isActive: boolean;
  handoffCount: number;
  lastHandoffAt: string | null;
  createdAt: string;
}

function mapRow(row: any): Advisor {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    phone: row.phone,
    isActive: row.is_active,
    handoffCount: row.handoff_count,
    lastHandoffAt: row.last_handoff_at ? new Date(row.last_handoff_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class AdvisorService {
  static async list(userId: number): Promise<Advisor[]> {
    const { rows } = await db.query('SELECT * FROM advisors WHERE user_id = $1 ORDER BY name ASC', [userId]);
    return rows.map(mapRow);
  }

  static async getById(userId: number, id: number): Promise<Advisor | null> {
    const { rows } = await db.query('SELECT * FROM advisors WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  static async create(userId: number, name: string, phone: string): Promise<Advisor> {
    const { rows } = await db.query(
      `INSERT INTO advisors (user_id, name, phone) VALUES ($1, $2, $3) RETURNING *`,
      [userId, name, phone]
    );
    return mapRow(rows[0]);
  }

  static async update(
    userId: number,
    id: number,
    data: { name?: string; phone?: string; isActive?: boolean }
  ): Promise<Advisor | null> {
    const { rows } = await db.query(
      `UPDATE advisors SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         is_active = COALESCE($3, is_active)
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [data.name ?? null, data.phone ?? null, data.isActive ?? null, id, userId]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  static async delete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM advisors WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** Busca un asesor activo por teléfono (comparando solo dígitos) — para reconocer cuando quien
   * le escribe al número del bot es el propio asesor (comando "FIN" por WhatsApp, ver
   * handleAdvisorCommand) y no un cliente cualquiera. */
  static async findByPhone(userId: number, phone: string): Promise<Advisor | null> {
    const digits = phone.replace(/[^0-9]/g, '');
    if (!digits) return null;
    const { rows } = await db.query(
      `SELECT * FROM advisors WHERE user_id = $1 AND is_active = true AND regexp_replace(phone, '[^0-9]', '', 'g') = $2`,
      [userId, digits]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  static async resetCounts(userId: number): Promise<void> {
    await db.query('UPDATE advisors SET handoff_count = 0, last_handoff_at = NULL WHERE user_id = $1', [userId]);
  }

  /**
   * Elige a qué asesor ACTIVO le toca la próxima derivación de forma equitativa (el que menos
   * derivaciones tenga hasta ahora, y entre empatados el que hace más tiempo no recibe una o
   * nunca recibió ninguna) Y registra esa derivación (handoff_count + last_handoff_at) en la
   * MISMA operación atómica — el "FOR UPDATE SKIP LOCKED" de la subconsulta evita que dos
   * derivaciones concurrentes del mismo usuario elijan al mismo asesor antes de que cualquiera
   * de las dos termine de contarla (antes eran dos pasos sueltos: un SELECT del candidato acá y
   * un UPDATE aparte en recordHandoff, con esa ventana de carrera abierta en el medio).
   * Devuelve null si no hay ningún asesor activo.
   */
  static async pickNextAdvisor(userId: number): Promise<Advisor | null> {
    const { rows } = await db.query(
      `UPDATE advisors SET handoff_count = handoff_count + 1, last_handoff_at = now()
       WHERE id = (
         SELECT id FROM advisors
         WHERE user_id = $1 AND is_active = true
         ORDER BY handoff_count ASC, last_handoff_at ASC NULLS FIRST, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [userId]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Registra una derivación a un asesor elegido a mano (modo "fijo" del flujo) — pickNextAdvisor
   * ya cuenta la suya propia atómicamente, así que esto NO se llama después de esa. */
  static async recordHandoff(id: number): Promise<Advisor | null> {
    const { rows } = await db.query(
      `UPDATE advisors SET handoff_count = handoff_count + 1, last_handoff_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  // El bot NUNCA deja de responder por una derivación a asesor (a pedido explícito del usuario) —
  // esto solo evita asignarle un SEGUNDO asesor al mismo cliente mientras el primero todavía tiene
  // tiempo de contactarlo. Pasados estos minutos sin que se libere a mano (panel/FINISH_FLOW), la
  // reserva vence sola y un nuevo pedido de asesor puede volver a asignar a cualquiera.
  static readonly HANDOFF_RESERVATION_MINUTES = 30;

  /**
   * Si esta conversación YA tiene un asesor reservado y esa reserva todavía no venció
   * (bot_contacts.handoff_advisor_id/handoff_expires_at — ver reserveHandoffAdvisor/
   * releaseHandoffReservationByJid en botContact.service.ts), lo devuelve — para que ningún camino
   * de derivación (regla legacy, tool de IA, bloque "Contactar Asesor" del flujo) le asigne un
   * SEGUNDO asesor al mismo cliente por accidente. Pasados los 30 minutos, o si nadie liberó la
   * reserva a mano, devuelve null igual — el cliente puede pedir un asesor de nuevo con total
   * normalidad.
   */
  static async getActiveHandoffAdvisor(userId: number, jid: string): Promise<Advisor | null> {
    const { BotContactService } = await import('./botContact.service.js');
    const reservation = await BotContactService.getHandoffReservation(userId, jid);
    if (!reservation.advisorId || !reservation.expiresAt || reservation.expiresAt <= new Date()) return null;
    return AdvisorService.getById(userId, reservation.advisorId);
  }

  /**
   * Deriva esta conversación a un asesor humano (Issue #30 [BE-049], punto 2 y 3): elige al
   * siguiente por round-robin, genera un resumen breve con IA (modo 'utility', sin tools ni
   * Base de Conocimiento — es una tarea de redacción, no una respuesta al cliente) y le manda al
   * asesor un WhatsApp con los datos del cliente + ese resumen. Usada tanto por la regla legacy
   * CALL_AI/HANDOFF (botEngine.service.ts) como por la tool de function-calling
   * handoff_to_advisor (ai.service.ts) — a diferencia del bloque "Contactar Asesor" del editor de
   * flujos (ver HandoffService), que tiene su propia plantilla configurable y NO pasa por acá.
   *
   * Antes de elegir uno nuevo, chequea getActiveHandoffAdvisor: si el cliente ya está en fila con
   * alguien, devuelve status 'already_pending' con ESE mismo asesor en vez de derivar a otro.
   *
   * Importa AIService/WhatsappService de forma dinámica (no en el import estático de arriba) para
   * no crear un ciclo: whatsapp.service.ts -> handoff.service.ts -> advisor.service.ts ya existe,
   * así que este archivo no puede importar whatsapp.service.ts de entrada sin cerrar ese ciclo.
   */
  static async handoffConversation(
    userId: number,
    customerPhone: string,
    customerName: string,
    conversationHistory: { role: 'user' | 'assistant' | 'system'; content: string }[]
  ): Promise<
    | { status: 'handed_off'; advisor: Advisor; summary: string }
    | { status: 'already_pending'; advisor: Advisor }
    | { status: 'no_advisor' }
  > {
    const { WhatsappService } = await import('./whatsapp.service.js');
    const jid = WhatsappService.phoneToJid(customerPhone);
    const existing = await AdvisorService.getActiveHandoffAdvisor(userId, jid);
    if (existing) return { status: 'already_pending', advisor: existing };

    const advisor = await AdvisorService.pickNextAdvisor(userId);
    if (!advisor) return { status: 'no_advisor' };

    let summary = 'El cliente necesita atención — no se pudo generar un resumen automático.';
    try {
      const { AIService } = await import('./ai.service.js');
      const transcript = conversationHistory.map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n');
      const { text } = await AIService.processMessage(
        `Resumí en máximo 5 líneas esta conversación de WhatsApp para que un asesor humano pueda retomar la atención:\n${transcript}`,
        [],
        {},
        '',
        '',
        'utility'
      );
      if (text.trim()) summary = text.trim();
    } catch (err) {
      console.error('❌ [AdvisorService] No se pudo generar el resumen de la charla con IA:', err);
    }

    const message = [
      '🔔 *Derivación Automática*',
      `📱 Cliente: ${customerName} (${looksLikePhoneDigits(customerPhone.replace(/[^0-9]/g, '')) ? customerPhone : 'número oculto — usuario de WhatsApp'})`,
      `📋 Resumen: ${summary}`,
      '💬 Respondé a este número para continuar la atención.',
    ].join('\n');

    try {
      await WhatsappService.sendTextMessage(advisor.phone, message, userId);
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo notificar al asesor "${advisor.name}":`, err);
    }

    return { status: 'handed_off', advisor, summary };
  }

  /** Le manda al CLIENTE el mensaje de seguimiento después de que se cierra la atención humana —
   * usado tanto por finishAdvisory como por la ruta PUT /bot-contacts/:id/resume-bot (que limpia
   * la reserva por id de fila en vez de por jid, ver clearHandoffPause). */
  static async notifyCustomerFollowUp(userId: number, jid: string): Promise<void> {
    const { WhatsappService } = await import('./whatsapp.service.js');
    await WhatsappService.sendTextMessage(jid.split('@')[0], '¿Quedó resuelta tu consulta? Contame si necesitás algo más 🙂', userId);
  }

  /**
   * Cierra la atención humana de esta conversación: libera la reserva (bot_contacts.
   * handoff_advisor_id/handoff_expires_at) para que un próximo pedido de asesor pueda asignar a
   * cualquiera sin esperar los 30 minutos, y si HABÍA una reserva vigente le pregunta al cliente
   * si quedó resuelta su consulta. Usado por el botón "Finalizar atención" del panel (POST
   * /bot-contacts/unpause) y por el comando "FIN" que el asesor manda por WhatsApp (ver
   * handleAdvisorCommand más abajo).
   *
   * Si se pasa `expectedAdvisorId`, solo actúa cuando la reserva vigente es justo de ESE asesor —
   * evita que el comando "FIN" de un asesor cierre por error la atención de otro (ej. si escribe
   * mal el número del cliente y ese número resulta tener una reserva de un compañero).
   */
  static async finishAdvisory(
    userId: number,
    jid: string,
    opts?: { expectedAdvisorId?: number }
  ): Promise<'notified' | 'no_active_reservation' | 'mismatch'> {
    const { BotContactService } = await import('./botContact.service.js');
    const reservation = await BotContactService.getHandoffReservation(userId, jid);
    const active = !!reservation.advisorId && !!reservation.expiresAt && reservation.expiresAt > new Date();

    if (opts?.expectedAdvisorId && (!active || reservation.advisorId !== opts.expectedAdvisorId)) {
      return 'mismatch';
    }

    await BotContactService.releaseHandoffReservationByJid(userId, jid);
    if (!active) return 'no_active_reservation';

    try {
      await AdvisorService.notifyCustomerFollowUp(userId, jid);
    } catch (err) {
      console.error('⚠️ [AdvisorService] No se pudo enviar el mensaje de seguimiento al cliente:', err);
    }
    return 'notified';
  }

  // Espera de "número del cliente" tras un "FIN"/"LISTO" (ver handleAdvisorCommand) — clave
  // `${userId}:${advisorId}`. En memoria a propósito, igual que FlowEngineService.userStates: si
  // el proceso reinicia justo en el medio, el asesor solo tiene que volver a escribir "FIN".
  private static pendingFinishByAdvisor = new Set<string>();

  private static async replyToAdvisor(userId: number, advisor: Advisor, text: string): Promise<void> {
    const { WhatsappService } = await import('./whatsapp.service.js');
    try {
      await WhatsappService.sendTextMessage(advisor.phone, text, userId);
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo responder al asesor "${advisor.name}":`, err);
    }
  }

  /**
   * Reconoce cuando quien le escribe al número del bot es un asesor humano (no un cliente) dando
   * la orden de cerrar una atención — flujo pedido: el asesor escribe "FIN"/"LISTO", el bot le
   * pregunta el número del cliente que atendió, el asesor responde con ese número, y recién ahí se
   * libera la reserva + se le pregunta al cliente si quedó resuelta su consulta (ver
   * finishAdvisory). Se usan palabras clave de TEXTO en vez de botones nativos de WhatsApp a
   * propósito: Baileys automatiza una cuenta normal (no la API oficial de Business), y ahí los
   * botones interactivos no son confiables — WhatsApp puede bloquearlos o mostrarlos como texto
   * plano sin aviso.
   *
   * Devuelve true si el mensaje era un comando de asesor y ya quedó atendido acá (whatsapp.
   * service.ts debe cortar el procesamiento normal ahí); false si no aplica y el mensaje debe
   * seguir su camino normal (bot/flujo/IA).
   */
  static async handleAdvisorCommand(userId: number, phone: string, text: string): Promise<boolean> {
    const advisor = await AdvisorService.findByPhone(userId, phone);
    if (!advisor) return false;

    const key = `${userId}:${advisor.id}`;
    const trimmed = text.trim();

    if (AdvisorService.pendingFinishByAdvisor.has(key)) {
      AdvisorService.pendingFinishByAdvisor.delete(key);
      const digits = trimmed.replace(/[^0-9]/g, '');
      if (digits.length < 8) {
        await AdvisorService.replyToAdvisor(userId, advisor, 'No reconocí ese número. Escribí FIN de nuevo para intentarlo otra vez.');
        return true;
      }

      const { WhatsappService } = await import('./whatsapp.service.js');
      const clientJid = WhatsappService.phoneToJid(digits);
      const result = await AdvisorService.finishAdvisory(userId, clientJid, { expectedAdvisorId: advisor.id });
      const reply =
        result === 'notified'
          ? 'Listo ✅ Se liberó la atención y se le preguntó al cliente si quedó resuelta su consulta.'
          : 'No encontré ninguna atención activa tuya con ese número.';
      await AdvisorService.replyToAdvisor(userId, advisor, reply);
      return true;
    }

    if (/^(fin|listo)$/i.test(trimmed)) {
      AdvisorService.pendingFinishByAdvisor.add(key);
      await AdvisorService.replyToAdvisor(userId, advisor, '¿Cuál es el número del cliente que atendiste?');
      return true;
    }

    return false;
  }
}
