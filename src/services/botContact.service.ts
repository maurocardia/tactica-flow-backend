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
  handoffPausedUntil: string | null;
}

export interface GatingFlags {
  isBlacklisted: boolean;
  botEnabled: boolean;
  handoffPausedUntil: Date | null;
  handoffAdvisorId: number | null;
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
    handoffPausedUntil: row.handoff_paused_until ? new Date(row.handoff_paused_until).toISOString() : null,
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
   * Una sola consulta con TODO lo que el camino caliente de un mensaje entrante necesita chequear
   * antes de dejar responder al bot (blacklist, switch por contacto, pausa por handoff) — antes
   * eran dos round-trips separados (isBlacklisted + isEnabled); agregar la pausa como una tercera
   * consulta habría sumado latencia a CADA mensaje. Si la fila todavía no existe (contacto nuevo,
   * el upsert de handleIncomingMessage es fire-and-forget y puede no haber terminado todavía),
   * devuelve defaults seguros: no bloqueado, no habilitado, sin pausa.
   */
  static async getGatingFlags(userId: number, jid: string): Promise<GatingFlags> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `SELECT is_blacklisted, bot_enabled, handoff_paused_until, handoff_advisor_id
       FROM bot_contacts WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
    if (rows.length === 0) {
      return { isBlacklisted: false, botEnabled: false, handoffPausedUntil: null, handoffAdvisorId: null };
    }
    const row = rows[0];
    return {
      isBlacklisted: row.is_blacklisted,
      botEnabled: row.bot_enabled,
      handoffPausedUntil: row.handoff_paused_until ? new Date(row.handoff_paused_until) : null,
      handoffAdvisorId: row.handoff_advisor_id ?? null,
    };
  }

  /** Pausa el bot para esta conversación puntual tras derivarla a un asesor (bloque "Contactar
   * Asesor" del flujo) — ver HandoffService. `minutes` 0/null pausa hasta reactivación manual
   * (handoff_paused_until queda en una fecha muy lejana en vez de NULL, para no confundirla con
   * "nunca hubo un handoff"). */
  static async setHandoffPause(userId: number, jid: string, advisorId: number | null, minutes: number | null): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const pausedUntil = minutes && minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000) : new Date('9999-01-01T00:00:00Z');
    await db.query(
      `UPDATE bot_contacts
       SET handoff_advisor_id = $1, handoff_started_at = now(), handoff_paused_until = $2
       WHERE user_id = $3 AND owner_jid = $4 AND jid = $5`,
      [advisorId, pausedUntil, userId, ownerJid, jid]
    );
  }

  /**
   * CIERRA el caso del todo — direccionado por jid en vez del id de fila, para los caminos que no
   * tienen ese id a mano: el botón "Finalizar atención y reactivar bot" de la tarjeta del chat
   * activo (solo conoce el jid abierto en WhatsApp Web) y el nodo terminal FINISH_FLOW del editor
   * de flujos. Limpia handoff_advisor_id además de la pausa — es una decisión explícita de que
   * esta conversación terminó, así que el próximo "Contactar Asesor" debe poder elegir uno nuevo
   * sin restricciones. NO usar esto para "destrabar" al cliente sin cerrar el caso — ver
   * clearHandoffPauseKeepAdvisorByJid.
   */
  static async clearHandoffPauseByJid(userId: number, jid: string): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    await db.query(
      `UPDATE bot_contacts
       SET handoff_paused_until = NULL, handoff_advisor_id = NULL
       WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
  }

  /**
   * Destraba al cliente (el bot vuelve a responderle) SIN cerrar el caso: deja handoff_advisor_id
   * intacto a propósito. La usa el trigger maestro de flujo (WhatsappService.
   * tryBreakHandoffPauseWithMasterTrigger) cuando un cliente ya derivado escribe algo tipo "menú"
   * para poder seguir navegando el bot — si después vuelve a pedir un asesor, AdvisorService.
   * getActiveHandoffAdvisor todavía lo encuentra y evita derivarlo a una SEGUNDA persona.
   */
  static async clearHandoffPauseKeepAdvisorByJid(userId: number, jid: string): Promise<void> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    await db.query(
      `UPDATE bot_contacts SET handoff_paused_until = NULL WHERE user_id = $1 AND owner_jid = $2 AND jid = $3`,
      [userId, ownerJid, jid]
    );
  }

  /** Botón "Reactivar bot" del panel — decisión humana explícita de cerrar el caso, igual que
   * clearHandoffPauseByJid: también libera handoff_advisor_id (si no, un contacto reactivado a
   * mano desde acá quedaría "reservado" para el mismo asesor para siempre). */
  static async clearHandoffPause(id: number): Promise<BotContact | null> {
    const { rows } = await db.query(
      `UPDATE bot_contacts SET handoff_paused_until = NULL, handoff_advisor_id = NULL WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Borra un contacto/grupo puntual de la lista — botón "X" del panel. Solo afecta bot_contacts. */
  static async delete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM bot_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** Alta manual desde el panel (número que todavía no le escribió al bot). */
  static async addManual(userId: number, jid: string, name: string, enabled: boolean): Promise<BotContact> {
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows } = await db.query(
      `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, bot_enabled)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (user_id, owner_jid, jid) DO UPDATE SET bot_enabled = EXCLUDED.bot_enabled
       RETURNING *`,
      [userId, ownerJid, jid, name, enabled]
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
    contacts: { phone: string; name?: string; enabled: boolean }[]
  ): Promise<{ created: number; updated: number; errors: number; errorDetails: string[] }> {
    const existingJids = new Set((await this.list(userId)).map((c) => c.jid));
    let created = 0;
    let updated = 0;
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
        await this.addManual(userId, jid, row.name?.trim() || cleanPhone, row.enabled);
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

    return { created, updated, errors, errorDetails };
  }
}
