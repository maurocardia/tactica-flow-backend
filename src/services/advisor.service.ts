import { db } from '../config/db.js';
import { looksLikePhoneDigits } from '../utils/whatsappIdentity.js';
import { trace, preview } from '../utils/trace.js';

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

  /**
   * Como pickNextAdvisor, pero solo entre los que NO tienen ya un cliente en relay activo (ver
   * botContact.service.ts: handoff_advisor_id/handoff_expires_at sin vencer) — un asesor atiende
   * UN cliente a la vez (ver comentario de advisor_queue en db.ts). Si hay más de uno libre,
   * prioriza al que lleva MÁS TIEMPO desocupado (freed_at ASC NULLS FIRST) antes que la equidad
   * por cantidad de derivaciones — a pedido explícito del usuario. Null = todos ocupados (o
   * ninguno activo) → AdvisorService.handoffConversation lo manda a la cola.
   */
  static async pickFreeAdvisor(userId: number): Promise<Advisor | null> {
    const { rows } = await db.query(
      `UPDATE advisors SET handoff_count = handoff_count + 1, last_handoff_at = now()
       WHERE id = (
         SELECT a.id FROM advisors a
         WHERE a.user_id = $1 AND a.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM bot_contacts bc
             WHERE bc.handoff_advisor_id = a.id AND bc.handoff_expires_at > now()
           )
         ORDER BY a.freed_at ASC NULLS FIRST, a.handoff_count ASC, a.last_handoff_at ASC NULLS FIRST, a.id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [userId]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Marca a este asesor como recién liberado — se llama al cerrar un relay (ver finishAdvisory),
   * para que pickFreeAdvisor sepa a quién priorizar la próxima vez que haya más de uno libre. */
  static async markFreed(id: number): Promise<void> {
    await db.query('UPDATE advisors SET freed_at = now() WHERE id = $1', [id]);
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
  // tiempo de contactarlo. Pasados estos minutos sin que se libere a mano (panel/FINISH_FLOW/comando
  // "FIN" por WhatsApp), la reserva vence sola y un nuevo pedido de asesor puede volver a asignar a
  // cualquiera. Configurable por cuenta (users.handoff_reservation_minutes, ver Configuración del
  // panel) — esto es solo el valor por default cuando esa columna es NULL.
  static readonly DEFAULT_HANDOFF_RESERVATION_MINUTES = 30;

  /** Cuántos minutos dura la reserva de asesor para ESTE usuario — ver
   * setHandoffReservationMinutes en AuthService y el default de arriba. */
  static async getReservationMinutes(userId: number): Promise<number> {
    const { AuthService } = await import('./auth.service.js');
    const user = await AuthService.getUserById(userId);
    return user?.handoffReservationMinutes ?? AdvisorService.DEFAULT_HANDOFF_RESERVATION_MINUTES;
  }

  // Timeout de inactividad de un relay YA ACTIVO — distinto de getReservationMinutes (esa es la
  // ventana antes/al asignar un asesor). Configurable aparte a pedido del usuario, mismo panel.
  static readonly DEFAULT_RELAY_INACTIVITY_MINUTES = 60;

  /** Minutos de silencio que tolera un relay activo de ESTE usuario antes de cerrarse solo — ver
   * setRelayInactivityMinutes en AuthService y slideHandoffExpiry en botContact.service.ts. */
  static async getRelayInactivityMinutes(userId: number): Promise<number> {
    const { AuthService } = await import('./auth.service.js');
    const user = await AuthService.getUserById(userId);
    return user?.relayInactivityMinutes ?? AdvisorService.DEFAULT_RELAY_INACTIVITY_MINUTES;
  }

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
   * Deriva esta conversación a un asesor humano (Issue #30 [BE-049], punto 2 y 3): elige entre los
   * LIBRES por round-robin (pickFreeAdvisor — un asesor atiende un cliente en relay a la vez),
   * genera un resumen breve con IA (modo 'utility', sin tools ni Base de Conocimiento — es una
   * tarea de redacción, no una respuesta al cliente) y le manda al asesor un WhatsApp con los
   * datos del cliente + ese resumen. Usada tanto por la regla legacy CALL_AI/HANDOFF
   * (botEngine.service.ts) como por la tool de function-calling handoff_to_advisor (ai.service.ts)
   * — a diferencia del bloque "Contactar Asesor" del editor de flujos (ver HandoffService), que
   * tiene su propia plantilla configurable y sigue usando pickNextAdvisor (sin cola) por ahora.
   *
   * Si no hay ningún asesor libre (todos ocupados en relay con otro cliente) pero SÍ hay al menos
   * uno activo, encola al cliente (AdvisorQueueService) en vez de fallar — status 'queued'. Si
   * directamente no hay ningún asesor activo configurado, sigue devolviendo 'no_advisor' (encolar
   * ahí no serviría de nada, nadie lo va a levantar nunca).
   *
   * Antes de elegir, chequea en este orden: 1) getActiveHandoffAdvisor — ¿ya está en relay con
   * alguien? → 'already_pending'; 2) AdvisorQueueService.getPosition — ¿ya está en la cola? →
   * 'already_queued' con su posición actual (no se lo vuelve a encolar ni se le cambia el lugar).
   *
   * Importa AIService/WhatsappService/AdvisorQueueService de forma dinámica (no en el import
   * estático de arriba) para no crear un ciclo: whatsapp.service.ts -> handoff.service.ts ->
   * advisor.service.ts ya existe, así que este archivo no puede importar whatsapp.service.ts de
   * entrada sin cerrar ese ciclo.
   */
  static async handoffConversation(
    userId: number,
    customerPhone: string,
    customerName: string,
    conversationHistory: { role: 'user' | 'assistant' | 'system'; content: string }[]
  ): Promise<
    | { status: 'handed_off'; advisor: Advisor; summary: string }
    | { status: 'already_pending'; advisor: Advisor }
    | { status: 'already_queued'; position: number }
    | { status: 'queued'; position: number }
    | { status: 'no_advisor' }
  > {
    const { WhatsappService } = await import('./whatsapp.service.js');
    const { AdvisorQueueService } = await import('./advisorQueue.service.js');
    const jid = WhatsappService.phoneToJid(customerPhone);

    const existing = await AdvisorService.getActiveHandoffAdvisor(userId, jid);
    if (existing) {
      trace('DERIVACION_YA_ASIGNADO', { usuario: userId, cliente: jid, asesor: existing.name });
      return { status: 'already_pending', advisor: existing };
    }

    const queuedPosition = await AdvisorQueueService.getPosition(userId, jid);
    if (queuedPosition !== null) {
      trace('DERIVACION_YA_EN_COLA', { usuario: userId, cliente: jid, posicion: queuedPosition });
      return { status: 'already_queued', position: queuedPosition };
    }

    const advisor = await AdvisorService.pickFreeAdvisor(userId);
    if (!advisor) {
      const { rows: activeCountRows } = await db.query(
        'SELECT COUNT(*)::int AS count FROM advisors WHERE user_id = $1 AND is_active = true',
        [userId]
      );
      if (activeCountRows[0].count === 0) {
        trace('DERIVACION_SIN_ASESORES', { usuario: userId, cliente: jid });
        return { status: 'no_advisor' };
      }

      const position = await AdvisorQueueService.enqueue(userId, jid, customerName);
      trace('COLA_ENCOLADO', { usuario: userId, cliente: jid, nombre: customerName, posicion: position, motivo: 'todos los asesores ocupados' });
      return { status: 'queued', position };
    }
    trace('DERIVACION_ASESOR_ELEGIDO', { usuario: userId, cliente: jid, asesor: advisor.name, asesorTel: advisor.phone });

    // Reservar ACÁ, antes de generar el resumen y notificar al asesor — no después. El llamador
    // (whatsapp.service.ts) recién llama a HandoffService.execute (que es quien reserva vía
    // ctx.resolvedAdvisor) DESPUÉS de aplicar el delay humanizado y mandarle la respuesta al
    // cliente, varios segundos después de que el asesor ya recibió el WhatsApp "Escribile por acá
    // mismo". Si el asesor contestaba rápido, esa primera respuesta llegaba ANTES de que existiera
    // la reserva: getActiveClientForAdvisor no encontraba nada, handleAdvisorCommand devolvía
    // false, y el mensaje cortaba por el pipeline normal (el bot le respondía a él como si fuera
    // un cliente) en vez de reenviarse — confirmado en logs/capturas: el primer mensaje del
    // asesor se perdía y recién el segundo (ya con la reserva escrita) se reenviaba bien.
    const reservationMinutes = await AdvisorService.getReservationMinutes(userId);
    try {
      const { BotContactService } = await import('./botContact.service.js');
      await BotContactService.reserveHandoffAdvisor(userId, jid, advisor.id, reservationMinutes);
      trace('DERIVACION_RESERVA_OK', { usuario: userId, cliente: jid, asesor: advisor.name, minutos: reservationMinutes });
    } catch (err) {
      console.error('❌ [AdvisorService] Error reservando el asesor antes de notificarlo:', err);
      trace('DERIVACION_RESERVA_ERROR', { usuario: userId, cliente: jid, asesor: advisor.name, error: (err as Error)?.message });
    }

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
      '💬 Escribile por acá mismo y se lo reenvío — cuando termines, escribí FIN.',
    ].join('\n');

    try {
      await WhatsappService.sendTextMessage(advisor.phone, message, userId, 'derivación→asesor');
      trace('DERIVACION_NOTIFICADA', { usuario: userId, cliente: jid, asesor: advisor.name, asesorTel: advisor.phone });
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo notificar al asesor "${advisor.name}":`, err);
      trace('DERIVACION_NOTIFICACION_ERROR', { usuario: userId, cliente: jid, asesor: advisor.name, error: (err as Error)?.message });
    }

    return { status: 'handed_off', advisor, summary };
  }

  /**
   * Conecta al siguiente cliente de la cola con este asesor, que se acaba de liberar — reserva
   * (BotContactService.reserveHandoffAdvisor) y manda el mensaje de apertura a ambos lados. A
   * diferencia de handoffConversation, NO genera resumen con IA (para no demorar la promoción): el
   * cliente ya le puede contar directo al asesor por el relay. No hace nada si la cola está vacía.
   * Se llama desde finishAdvisory (cierre explícito) y desde AdvisorQueueWorker (sweep periódico,
   * por si el relay anterior se cerró solo por inactividad sin que nadie escriba "FIN").
   */
  static async promoteNextFromQueue(userId: number, advisor: Advisor): Promise<void> {
    const { AdvisorQueueService } = await import('./advisorQueue.service.js');
    const { BotContactService } = await import('./botContact.service.js');
    const { WhatsappService } = await import('./whatsapp.service.js');

    const next = await AdvisorQueueService.dequeueFirst(userId);
    if (!next) {
      trace('COLA_VACIA', { usuario: userId, asesorLibre: advisor.name });
      return;
    }
    trace('COLA_DESPACHADO', { usuario: userId, cliente: next.jid, nombre: next.customerName, asesor: advisor.name, asesorTel: advisor.phone });

    const minutes = await AdvisorService.getReservationMinutes(userId);
    await BotContactService.reserveHandoffAdvisor(userId, next.jid, advisor.id, minutes);

    const phone = next.jid.split('@')[0];
    try {
      await WhatsappService.sendTextMessage(
        advisor.phone,
        [
          '🔔 *Se te asignó un cliente que estaba en la cola*',
          `📱 Cliente: ${next.customerName} (${phone})`,
          '💬 Escribile por acá mismo y se lo reenvío — cuando termines, escribí FIN.',
        ].join('\n'),
        userId,
        'cola→asesor'
      );
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo notificar al asesor "${advisor.name}" sobre la promoción de cola:`, err);
    }
    try {
      await WhatsappService.sendTextMessage(phone, `Ya te podés comunicar con ${advisor.name}, nuestro asesor — escribile por acá mismo.`, userId, 'cola→cliente');
    } catch (err) {
      console.error('⚠️ [AdvisorService] No se pudo avisarle al cliente que ya tiene asesor:', err);
    }
  }

  /** Le manda al CLIENTE el mensaje de seguimiento después de que se cierra la atención humana —
   * usado tanto por finishAdvisory como por la ruta PUT /bot-contacts/:id/resume-bot (que limpia
   * la reserva por id de fila en vez de por jid, ver clearHandoffPause). */
  static async notifyCustomerFollowUp(userId: number, jid: string): Promise<void> {
    const { WhatsappService } = await import('./whatsapp.service.js');
    await WhatsappService.sendTextMessage(jid.split('@')[0], '¿Quedó resuelta tu consulta? Contame si necesitás algo más 🙂', userId, 'seguimiento→cliente');
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
      trace('ATENCION_CIERRE_RECHAZADO', { usuario: userId, cliente: jid, asesorEsperado: opts.expectedAdvisorId, asesorReservado: reservation.advisorId, activa: active });
      return 'mismatch';
    }

    await BotContactService.releaseHandoffReservationByJid(userId, jid);
    trace('ATENCION_CERRADA', { usuario: userId, cliente: jid, asesorId: reservation.advisorId, estabaActiva: active });
    if (!active) return 'no_active_reservation';

    try {
      await AdvisorService.notifyCustomerFollowUp(userId, jid);
    } catch (err) {
      console.error('⚠️ [AdvisorService] No se pudo enviar el mensaje de seguimiento al cliente:', err);
    }

    // Se acaba de liberar un cupo — si hay alguien esperando en la cola, se le asigna a ESTE
    // asesor antes que a cualquiera (así el próximo handoffConversation no se lo lleva primero).
    if (reservation.advisorId) {
      await AdvisorService.markFreed(reservation.advisorId);
      try {
        const advisor = await AdvisorService.getById(userId, reservation.advisorId);
        if (advisor) await AdvisorService.promoteNextFromQueue(userId, advisor);
      } catch (err) {
        console.error('⚠️ [AdvisorService] Error promoviendo el siguiente de la cola:', err);
      }
    }
    return 'notified';
  }

  private static async replyToAdvisor(userId: number, advisor: Advisor, text: string): Promise<void> {
    const { WhatsappService } = await import('./whatsapp.service.js');
    try {
      await WhatsappService.sendTextMessage(advisor.phone, text, userId, 'respuesta→asesor');
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo responder al asesor "${advisor.name}":`, err);
    }
  }

  /**
   * Reconoce cuando quien le escribe al número del bot es un asesor humano (no un cliente) —
   * relay bidireccional: mientras el asesor tiene un cliente en relay activo (ver
   * BotContactService.getActiveClientForAdvisor — un asesor atiende UNO a la vez), cualquier
   * mensaje normal se le reenvía tal cual a ESE cliente, rotulado con el nombre del asesor, y la
   * reserva se corre hacia adelante (sliding timeout, ver slideHandoffExpiry). Si en cambio
   * escribe "FIN"/"LISTO", se cierra esa atención (finishAdvisory) — como ya sabemos con CUÁL
   * cliente está (uno solo a la vez), no hace falta preguntarle el número como antes.
   *
   * Se usan palabras clave de TEXTO en vez de botones nativos de WhatsApp a propósito: Baileys
   * automatiza una cuenta normal (no la API oficial de Business), y ahí los botones interactivos
   * no son confiables — WhatsApp puede bloquearlos o mostrarlos como texto plano sin aviso.
   *
   * Devuelve true si el mensaje era del asesor y ya quedó atendido acá (whatsapp.service.ts debe
   * cortar el procesamiento normal ahí); false si no aplica (no es un asesor, o es un asesor sin
   * cliente activo escribiendo otra cosa) y el mensaje debe seguir su camino normal.
   */
  static async handleAdvisorCommand(userId: number, phone: string, text: string): Promise<boolean> {
    const advisor = await AdvisorService.findByPhone(userId, phone);
    if (!advisor) return false;

    const { BotContactService } = await import('./botContact.service.js');
    const activeClientJid = await BotContactService.getActiveClientForAdvisor(userId, advisor.id);
    if (!activeClientJid) {
      // El que escribe ES un asesor, pero no tiene cliente asignado ahora: el mensaje sigue el
      // camino normal (el bot le contesta como a cualquier contacto) y NO se reenvía a nadie.
      trace('ASESOR_SIN_CLIENTE_ACTIVO', { usuario: userId, asesor: advisor.name, asesorTel: phone, texto: preview(text) });
      return false;
    }
    trace('ASESOR_RECONOCIDO', { usuario: userId, asesor: advisor.name, asesorTel: phone, cliente: activeClientJid });

    const trimmed = text.trim();
    if (/^(fin|listo)$/i.test(trimmed)) {
      trace('ASESOR_FIN', { usuario: userId, asesor: advisor.name, cliente: activeClientJid });
      const result = await AdvisorService.finishAdvisory(userId, activeClientJid, { expectedAdvisorId: advisor.id });
      const reply =
        result === 'notified'
          ? 'Listo ✅ Se liberó la atención y se le preguntó al cliente si quedó resuelta su consulta.'
          : 'No encontré ninguna atención activa tuya en este momento.';
      await AdvisorService.replyToAdvisor(userId, advisor, reply);
      return true;
    }

    // Relay: se le reenvía tal cual al cliente, rotulado — ninguno de los dos ve el número real
    // del otro. Se corre la reserva hacia adelante (getRelayInactivityMinutes, no
    // getReservationMinutes — son dos timeouts distintos) para que no venza en medio de una
    // charla activa.
    const { WhatsappService } = await import('./whatsapp.service.js');
    const minutes = await AdvisorService.getRelayInactivityMinutes(userId);
    trace('PUENTE_ASESOR_A_CLIENTE', { usuario: userId, asesor: advisor.name, cliente: activeClientJid, texto: preview(text) });
    try {
      await WhatsappService.sendTextMessage(activeClientJid.split('@')[0], `👨‍💼 *${advisor.name}:* ${text}`, userId, 'puente asesor→cliente');
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo reenviar el mensaje del asesor "${advisor.name}" al cliente:`, err);
    }
    await BotContactService.slideHandoffExpiry(userId, activeClientJid, minutes);
    return true;
  }
}
