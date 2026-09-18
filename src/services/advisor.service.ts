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

  /**
   * Deriva esta conversación a un asesor humano (Issue #30 [BE-049], punto 2 y 3): elige al
   * siguiente por round-robin, genera un resumen breve con IA (modo 'utility', sin tools ni
   * Base de Conocimiento — es una tarea de redacción, no una respuesta al cliente) y le manda al
   * asesor un WhatsApp con los datos del cliente + ese resumen. Usada tanto por la regla legacy
   * CALL_AI/HANDOFF (botEngine.service.ts) como por la tool de function-calling
   * handoff_to_advisor (ai.service.ts) — a diferencia del bloque "Contactar Asesor" del editor de
   * flujos (ver HandoffService), que tiene su propia plantilla configurable y NO pasa por acá.
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
  ): Promise<{ advisor: Advisor; summary: string } | null> {
    const advisor = await AdvisorService.pickNextAdvisor(userId);
    if (!advisor) return null;

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
      `📱 Cliente: ${customerName} (${customerPhone})`,
      `📋 Resumen: ${summary}`,
      '💬 Respondé a este número para continuar la atención.',
    ].join('\n');

    try {
      const { WhatsappService } = await import('./whatsapp.service.js');
      await WhatsappService.sendTextMessage(advisor.phone, message, userId);
    } catch (err) {
      console.error(`⚠️ [AdvisorService] No se pudo notificar al asesor "${advisor.name}":`, err);
    }

    return { advisor, summary };
  }
}
