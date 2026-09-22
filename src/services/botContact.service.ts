import { db } from '../config/db.js';
import { WhatsappService } from './whatsapp.service.js';

export interface BotContact {
  id: number;
  userId: number;
  ownerJid: string;
  jid: string;
  name: string;
  isGroup: boolean;
  botEnabled: boolean;
  isBlacklisted: boolean;
  lastActivity: string;
  handoffAdvisorId: number | null;
  // Vencimiento de la RESERVA del asesor asignado — el bot sigue respondiendo con normalidad
  // mientras tanto, esto solo evita que se derive al mismo cliente a otro asesor antes de tiempo.
  // Ver AdvisorService.getActiveHandoffAdvisor.
  handoffExpiresAt: string | null;
}

export interface GatingFlags {
  isBlacklisted: boolean;
  botEnabled: boolean;
}

function mapRow(row: any): BotContact {
  return {
    id: row.id,
    userId: row.user_id,
    ownerJid: row.owner_jid,
    jid: row.jid,
    name: row.name,
    isGroup: row.is_group,
    botEnabled: row.bot_enabled,
    isBlacklisted: row.is_blacklisted,
    lastActivity: new Date(row.last_activity).toISOString(),
    handoffAdvisorId: row.handoff_advisor_id ?? null,
    handoffExpiresAt: row.handoff_expires_at ? new Date(row.handoff_expires_at).toISOString() : null,
  };
}

/**
 * Registro liviano y separado de "conversations"/"messages" — ver comentario de la tabla
 * bot_contacts en db.ts. Es un espejo de solo-lectura desde el punto de vista de WhatsApp: se
 * llama a upsert() cada vez que llega actividad real (mensaje, sincronización de contactos), y
 * nunca toca el historial de charla.
 */
export class BotContactService {
  /**
   * Crea o actualiza el nombre/última actividad de un contacto. NUNCA toca `bot_enabled` de una
   * fila EXISTENTE (eso solo lo cambia el usuario a mano desde el panel, o el switch "Activar el
   * bot para contactos nuevos") — `defaultEnabled` solo aplica si la fila es nueva.
   */
  static async upsert(
    userId: number,
    jid: string,
    name: string,
    isGroup: boolean,
    activityAt: Date = new Date(),
    defaultEnabled: boolean = false
  ): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    await db.query(
      `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, last_activity, bot_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, owner_jid, jid) DO UPDATE
       SET name = EXCLUDED.name,
           last_activity = GREATEST(bot_contacts.last_activity, EXCLUDED.last_activity)`,
      [userId, ownerJid, jid, name, isGroup, activityAt, defaultEnabled]
    );
  }

  /**
   * Corrige el JID/nombre de una fila ya existente — pensado para el botón "Recargar" del panel,
   * cuando un contacto quedó mal agregado (ej. con un @lid viejo en vez del número real). Si el
   * nuevo JID ya pertenece a OTRA fila del mismo usuario (ya se resolvió bien por otro camino),
   * en vez de romper por la restricción UNIQUE se borra la fila vieja/rota y se deja la que ya
   * tenía el JID correcto.
   */
  static async updateIdentity(id: number, jid: string, name: string): Promise<BotContact | null> {
    try {
      const { rows } = await db.query(
        'UPDATE bot_contacts SET jid = $1, name = $2 WHERE id = $3 RETURNING *',
        [jid, name, id]
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    } catch (err: any) {
      if (err?.code === '23505') {
        // unique_violation: el JID correcto ya existe en otra fila — nos quedamos con esa y
        // borramos la rota.
        await db.query('DELETE FROM bot_contacts WHERE id = $1', [id]);
        const { rows } = await db.query('SELECT * FROM bot_contacts WHERE jid = $1', [jid]);
        return rows.length > 0 ? mapRow(rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Da de alta un contacto/grupo que Baileys reporta como real (agenda de contactos, grupos del
   * usuario) pero que todavía no generó actividad de chat — a diferencia de upsert(), NUNCA toca
   * `last_activity` de una fila existente, y si la fila es nueva la manda al fondo del orden
   * (timestamp época) en vez de "ahora". Sin esto, cada reconexión del backend empujaba todos los
   * grupos al principio de la lista (con `last_activity = now()`), tapando los contactos con
   * actividad real más reciente.
   */
  static async seedIfMissing(
    userId: number,
    jid: string,
    name: string,
    isGroup: boolean,
    activityAt: Date = new Date(0)
  ): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    await db.query(
      `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, owner_jid, jid) DO UPDATE SET name = EXCLUDED.name`,
      [userId, ownerJid, jid, name, isGroup, activityAt]
    );
  }

  static async list(userId: number): Promise<BotContact[]> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query('SELECT * FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 ORDER BY last_activity DESC', [userId, ownerJid]);
    return rows.map(mapRow);
  }

  static async setEnabled(id: number, enabled: boolean): Promise<BotContact | null> {
    const { rows } = await db.query('UPDATE bot_contacts SET bot_enabled = $1 WHERE id = $2 RETURNING *', [enabled, id]);
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Usado por WhatsappService para decidir si le responde o no a este contacto/grupo. */
  static async isEnabled(userId: number, jid: string): Promise<boolean> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query('SELECT bot_enabled FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 AND jid = $3', [userId, ownerJid, jid]);
    return rows.length > 0 ? rows[0].bot_enabled : false;
  }

  /**
   * Blacklist (pestaña del panel junto a Contactos/Grupos): gana por encima de CUALQUIER otro
   * switch — ver el chequeo al principio de WhatsappService.handleIncomingMessage, que se fija
   * esto ANTES que "Responder a todos" o el switch normal del contacto.
   */
  static async isBlacklisted(userId: number, jid: string): Promise<boolean> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      'SELECT is_blacklisted FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 AND jid = $3',
      [userId, ownerJid, jid]
    );
    return rows.length > 0 ? rows[0].is_blacklisted : false;
  }

  /** Bloquea/desbloquea una fila ya existente — is_blacklisted=true siempre apaga bot_enabled. */
  static async setBlacklisted(id: number, blacklisted: boolean): Promise<BotContact | null> {
    const { rows } = await db.query(
      `UPDATE bot_contacts
       SET is_blacklisted = $1, bot_enabled = CASE WHEN $1 THEN false ELSE bot_enabled END
       WHERE id = $2 RETURNING *`,
      [blacklisted, id]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Alta directa a la blacklist (número que nunca le escribió al bot pero se quiere bloquear igual). */
  static async addToBlacklist(userId: number, jid: string, name: string): Promise<BotContact> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, bot_enabled, is_blacklisted)
       VALUES ($1, $2, $3, $4, false, false, true)
       ON CONFLICT (user_id, owner_jid, jid) DO UPDATE SET is_blacklisted = true, bot_enabled = false
       RETURNING *`,
      [userId, ownerJid, jid, name]
    );
    return mapRow(rows[0]);
  }

  /**
   * Lo único que el camino caliente de un mensaje entrante necesita chequear antes de dejar
   * responder al bot: blacklist y el switch por contacto — ya NO incluye nada de handoff, porque
   * una derivación a asesor no bloquea al bot (ver AdvisorService.getActiveHandoffAdvisor para la
   * reserva de asesor, que es un chequeo aparte y no afecta si el bot responde o no). Si la fila
   * todavía no existe (contacto nuevo, el upsert de handleIncomingMessage es fire-and-forget y
   * puede no haber terminado todavía), devuelve defaults seguros: no bloqueado, no habilitado.
   */
  static async getGatingFlags(userId: number, jid: string): Promise<GatingFlags> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `SELECT is_blacklisted, bot_enabled FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
    if (rows.length === 0) {
      return { isBlacklisted: false, botEnabled: false };
    }
    return { isBlacklisted: rows[0].is_blacklisted, botEnabled: rows[0].bot_enabled };
  }

  /**
   * Reserva este asesor para esta conversación por `minutes` minutos (configurable por cuenta,
   * ver AdvisorService.getReservationMinutes) — NO afecta si el bot responde o no, solo evita que
   * otro camino de derivación le asigne un SEGUNDO asesor al mismo cliente mientras el primero
   * todavía tiene tiempo de contactarlo. Pasado ese tiempo, la reserva vence sola (no hace falta
   * limpiarla a mano) y un nuevo pedido de asesor puede volver a asignar.
   */
  static async reserveHandoffAdvisor(userId: number, jid: string, advisorId: number | null, minutes: number): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    await db.query(
      `UPDATE bot_contacts
       SET handoff_advisor_id = $1, handoff_started_at = now(), handoff_expires_at = $2
       WHERE user_id = $3 AND owner_jid = $4 AND jid = $5`,
      [advisorId, expiresAt, userId, ownerJid, jid]
    );
  }

  /**
   * Libera la reserva de asesor ANTES de que venza sola — direccionado por jid en vez del id de
   * fila, para los caminos que no tienen ese id a mano: el botón "Finalizar atención" de la
   * tarjeta del chat activo (solo conoce el jid abierto en WhatsApp Web) y el nodo terminal
   * FINISH_FLOW del editor de flujos. Es una decisión explícita de que esta conversación ya no
   * necesita a ese asesor puntual, así que el próximo "Contactar Asesor" puede elegir a cualquiera
   * sin esperar los 30 minutos.
   */
  static async releaseHandoffReservationByJid(userId: number, jid: string): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    await db.query(
      `UPDATE bot_contacts
       SET handoff_expires_at = NULL, handoff_advisor_id = NULL
       WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
  }

  /** Botón "Liberar asesor" del panel — misma decisión que releaseHandoffReservationByJid, pero
   * direccionado por el id de fila (lo que el panel tiene a mano) en vez del jid. Devuelve también
   * si HABÍA una reserva vigente antes de limpiarla (con el CTE "prev", capturado antes del
   * UPDATE) — la ruta lo usa para decidir si le manda al cliente el mensaje de seguimiento
   * ("¿quedó resuelta tu consulta?", ver AdvisorService.notifyCustomerFollowUp). */
  static async clearHandoffPause(id: number): Promise<{ contact: BotContact; hadActiveReservation: boolean } | null> {
    const { rows } = await db.query(
      `WITH prev AS (SELECT handoff_advisor_id, handoff_expires_at FROM bot_contacts WHERE id = $1)
       UPDATE bot_contacts SET handoff_expires_at = NULL, handoff_advisor_id = NULL
       WHERE id = $1
       RETURNING *, (SELECT handoff_advisor_id FROM prev) AS prev_advisor_id, (SELECT handoff_expires_at FROM prev) AS prev_expires_at`,
      [id]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const hadActiveReservation = !!row.prev_advisor_id && !!row.prev_expires_at && new Date(row.prev_expires_at) > new Date();
    return { contact: mapRow(row), hadActiveReservation };
  }

  /** Para AdvisorService.getActiveHandoffAdvisor: a quién está reservada esta conversación ahora
   * mismo, y hasta cuándo. null/expirado = sin reserva activa. */
  static async getHandoffReservation(userId: number, jid: string): Promise<{ advisorId: number | null; expiresAt: Date | null }> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `SELECT handoff_advisor_id, handoff_expires_at FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
    if (rows.length === 0) return { advisorId: null, expiresAt: null };
    return {
      advisorId: rows[0].handoff_advisor_id ?? null,
      expiresAt: rows[0].handoff_expires_at ? new Date(rows[0].handoff_expires_at) : null,
    };
  }

  /** Borra un contacto/grupo puntual de la lista — botón "X" del panel. Solo afecta bot_contacts. */
  static async delete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM bot_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** Alta manual desde el panel (número que todavía no le escribió al bot). */
  static async addManual(
    userId: number,
    jid: string,
    name: string,
    enabled: boolean,
    // La importación masiva pasa true: subir un contacto que ya estaba en la Blacklist como
    // "activo" tiene que sacarlo de ahí — antes solo se actualizaba bot_enabled y is_blacklisted
    // quedaba en true, así que el contacto seguía bloqueado (y visible en la Blacklist) aunque el
    // archivo lo marcara como activo. El alta manual normal no lo usa (no cambia su comportamiento).
    clearBlacklist: boolean = false
  ): Promise<BotContact> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, bot_enabled)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (user_id, owner_jid, jid) DO UPDATE SET
         bot_enabled = EXCLUDED.bot_enabled,
         is_blacklisted = CASE WHEN $6 THEN false ELSE bot_contacts.is_blacklisted END
       RETURNING *`,
      [userId, ownerJid, jid, name, enabled, clearBlacklist]
    );
    return mapRow(rows[0]);
  }

  /**
   * Importación masiva desde un CSV/Excel ya parseado en el frontend (ver BulkImportPreview.tsx):
   * fila por fila, reusa addManual() (mismo upsert por jid que ya usa el alta manual) para no
   * duplicar la normalización — solo agrega el conteo de nuevos vs. actualizados comparando
   * contra la lista existente ANTES de arrancar (si dos filas del archivo repiten el mismo
   * teléfono, la segunda ya cuenta como "actualización" en vez de otro "nuevo").
   */
  static async bulkImport(
    userId: number,
    contacts: { phone: string; name?: string; enabled: boolean; blacklisted?: boolean }[]
  ): Promise<{ created: number; updated: number; blacklisted: number; errors: number; errorDetails: string[] }> {
    const existingJids = new Set((await this.list(userId)).map((c) => c.jid));
    let created = 0;
    let updated = 0;
    let blacklisted = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const row of contacts) {
      try {
        const cleanPhone = String(row?.phone ?? '').replace(/[^0-9]/g, '');
        if (cleanPhone.length < 8) {
          errors++;
          errorDetails.push(`Teléfono inválido: "${row?.phone ?? ''}"`);
          continue;
        }
        if (typeof row?.enabled !== 'boolean') {
          errors++;
          errorDetails.push(`${cleanPhone}: falta el estado (enabled)`);
          continue;
        }
        const jid = `${cleanPhone}@s.whatsapp.net`;
        const wasExisting = existingJids.has(jid);
        const name = row.name?.trim() || cleanPhone;
        // "Bloquear" (Blacklist): a diferencia de enabled=false (solo apaga el switch del bot),
        // marca is_blacklisted=true para que el contacto aparezca en la pestaña Blacklist del
        // panel y nunca reciba respuesta — ver addToBlacklist.
        if (row.blacklisted === true) {
          await this.addToBlacklist(userId, jid, name);
          blacklisted++;
        } else {
          await this.addManual(userId, jid, name, row.enabled, true);
        }
        if (wasExisting) {
          updated++;
        } else {
          created++;
          existingJids.add(jid);
        }
      } catch (err) {
        errors++;
        errorDetails.push(`${row?.phone ?? '?'}: ${err instanceof Error ? err.message : 'error desconocido'}`);
      }
    }

    return { created, updated, blacklisted, errors, errorDetails };
  }
}
