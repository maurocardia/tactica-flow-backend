import { db } from '../config/db.js';

export interface BotContact {
  id: number;
  userId: number;
  jid: string;
  name: string;
  isGroup: boolean;
  botEnabled: boolean;
  lastActivity: string;
}

function mapRow(row: any): BotContact {
  return {
    id: row.id,
    userId: row.user_id,
    jid: row.jid,
    name: row.name,
    isGroup: row.is_group,
    botEnabled: row.bot_enabled,
    lastActivity: new Date(row.last_activity).toISOString(),
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
    await db.query(
      `INSERT INTO bot_contacts (user_id, jid, name, is_group, last_activity, bot_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, jid) DO UPDATE
       SET name = EXCLUDED.name,
           last_activity = GREATEST(bot_contacts.last_activity, EXCLUDED.last_activity)`,
      [userId, jid, name, isGroup, activityAt, defaultEnabled]
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
    await db.query(
      `INSERT INTO bot_contacts (user_id, jid, name, is_group, last_activity)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, jid) DO UPDATE SET name = EXCLUDED.name`,
      [userId, jid, name, isGroup, activityAt]
    );
  }

  static async list(userId: number): Promise<BotContact[]> {
    const { rows } = await db.query('SELECT * FROM bot_contacts WHERE user_id = $1 ORDER BY last_activity DESC', [userId]);
    return rows.map(mapRow);
  }

  static async setEnabled(id: number, enabled: boolean): Promise<BotContact | null> {
    const { rows } = await db.query('UPDATE bot_contacts SET bot_enabled = $1 WHERE id = $2 RETURNING *', [enabled, id]);
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Usado por WhatsappService para decidir si le responde o no a este contacto/grupo. */
  static async isEnabled(userId: number, jid: string): Promise<boolean> {
    const { rows } = await db.query('SELECT bot_enabled FROM bot_contacts WHERE user_id = $1 AND jid = $2', [userId, jid]);
    return rows.length > 0 ? rows[0].bot_enabled : false;
  }

  /** Borra un contacto/grupo puntual de la lista — botón "X" del panel. Solo afecta bot_contacts. */
  static async delete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM bot_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** Alta manual desde el panel (número que todavía no le escribió al bot). */
  static async addManual(userId: number, jid: string, name: string, enabled: boolean): Promise<BotContact> {
    const { rows } = await db.query(
      `INSERT INTO bot_contacts (user_id, jid, name, is_group, bot_enabled)
       VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (user_id, jid) DO UPDATE SET bot_enabled = EXCLUDED.bot_enabled
       RETURNING *`,
      [userId, jid, name, enabled]
    );
    return mapRow(rows[0]);
  }
}
