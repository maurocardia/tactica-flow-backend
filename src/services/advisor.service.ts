import { db } from '../config/db.js';

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

  static async resetCounts(userId: number): Promise<void> {
    await db.query('UPDATE advisors SET handoff_count = 0, last_handoff_at = NULL WHERE user_id = $1', [userId]);
  }

  /**
   * Elige a qué asesor ACTIVO le toca la próxima derivación de forma equitativa: el que menos
   * derivaciones tenga hasta ahora, y entre empatados el que hace más tiempo no recibe una (o
   * nunca recibió ninguna) — así ninguno queda sobrecargado mientras otros no reciben nada.
   * Devuelve null si no hay ningún asesor activo.
   *
   * NOTA: esto solo elige y registra la derivación (ver recordHandoff) — no decide CUÁNDO el bot
   * debe derivar una conversación a un humano; esa lógica (que el bot detecte que necesita
   * intervención) no forma parte de estos endpoints y queda pendiente.
   */
  static async pickNextAdvisor(userId: number): Promise<Advisor | null> {
    const { rows } = await db.query(
      `SELECT * FROM advisors
       WHERE user_id = $1 AND is_active = true
       ORDER BY handoff_count ASC, last_handoff_at ASC NULLS FIRST, id ASC
       LIMIT 1`,
      [userId]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /** Registra que se le acaba de derivar una conversación a este asesor. */
  static async recordHandoff(id: number): Promise<Advisor | null> {
    const { rows } = await db.query(
      `UPDATE advisors SET handoff_count = handoff_count + 1, last_handoff_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }
}
