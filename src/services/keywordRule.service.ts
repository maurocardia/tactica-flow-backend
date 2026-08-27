import { randomUUID } from 'crypto';
import { db } from '../config/db.js';

export type RuleAction =
  | 'STATIC_REPLY'
  | 'CALL_AI'
  | 'TACTICA_STOCK_LOOKUP'
  | 'CREATE_SUPPORT_TICKET'
  | 'HANDOFF'
  | 'DELAY'
  | 'WEBHOOK';

export interface KeywordRule {
  id: string;
  name: string;
  keywords: string[];
  replyText: string;
  action: RuleAction;
  isActive: boolean;
  createdAt: string; // ISO
}

function mapRuleRow(row: any): KeywordRule {
  return {
    id: row.id,
    name: row.name,
    keywords: row.keywords,
    replyText: row.reply_text,
    action: row.action,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class KeywordRuleService {
  /**
   * Siembra las 2 reglas por defecto (saludo y horario) la primera vez que se corre contra
   * una base vacía, para no cambiar el comportamiento del bot en el primer arranque. Se llama
   * una vez al iniciar el servidor, después de initDatabase(). No hace nada si ya hay reglas.
   */
  static async seedIfEmpty(): Promise<void> {
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM keyword_rules');
    if (rows[0].count > 0) return;

    await db.query(
      `INSERT INTO keyword_rules (id, name, keywords, reply_text, action, is_active) VALUES
       ($1, $2, $3, $4, 'STATIC_REPLY', true),
       ($5, $6, $7, $8, 'STATIC_REPLY', true)`,
      [
        randomUUID(),
        'Saludo de bienvenida',
        ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos'],
        '¡Hola! 👋 Bienvenido a la atención automatizada de Tactica Flow. ¿En qué te podemos ayudar hoy?\n\n1. Consultar Stock o Catálogo 📦\n2. Consultar Estado de Pedido 📋\n3. Soporte Técnico / Incidente 🛠️',
        randomUUID(),
        'Horario de atención',
        ['horario', 'horarios', 'atencion', 'abierto', 'direccion'],
        '🕒 Nuestro horario de atención comercial es de Lunes a Viernes de 9:00 a 18:00 hs.',
      ]
    );
  }

  static async listRules(): Promise<KeywordRule[]> {
    const { rows } = await db.query('SELECT * FROM keyword_rules ORDER BY created_at DESC');
    return rows.map(mapRuleRow);
  }

  static async listActiveRules(): Promise<KeywordRule[]> {
    const { rows } = await db.query(
      'SELECT * FROM keyword_rules WHERE is_active = true ORDER BY created_at DESC'
    );
    return rows.map(mapRuleRow);
  }

  static async getRule(id: string): Promise<KeywordRule | null> {
    const { rows } = await db.query('SELECT * FROM keyword_rules WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    return mapRuleRow(rows[0]);
  }

  static async createRule(data: {
    name: string;
    keywords: string[];
    replyText: string;
    action?: RuleAction;
    isActive?: boolean;
  }): Promise<KeywordRule> {
    const trimmedName = data.name.trim();
    const trimmedReplyText = data.replyText.trim();
    const trimmedKeywords = data.keywords.map((kw) => kw.trim()).filter((kw) => kw.length > 0);
    const id = randomUUID();
    const action = data.action || 'STATIC_REPLY';
    const isActive = data.isActive !== undefined ? data.isActive : true;

    const { rows } = await db.query(
      `INSERT INTO keyword_rules (id, name, keywords, reply_text, action, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, trimmedName, trimmedKeywords, trimmedReplyText, action, isActive]
    );

    return mapRuleRow(rows[0]);
  }

  static async updateRule(
    id: string,
    data: Partial<{
      name: string;
      keywords: string[];
      replyText: string;
      action: RuleAction;
      isActive: boolean;
    }>
  ): Promise<KeywordRule | null> {
    const existing = await this.getRule(id);
    if (!existing) return null;

    const name = data.name !== undefined ? data.name.trim() : existing.name;
    const keywords =
      data.keywords !== undefined
        ? data.keywords.map((kw) => kw.trim()).filter((kw) => kw.length > 0)
        : existing.keywords;
    const replyText = data.replyText !== undefined ? data.replyText.trim() : existing.replyText;
    const action = data.action !== undefined ? data.action : existing.action;
    const isActive = data.isActive !== undefined ? data.isActive : existing.isActive;

    const { rows } = await db.query(
      `UPDATE keyword_rules SET name = $1, keywords = $2, reply_text = $3, action = $4, is_active = $5
       WHERE id = $6 RETURNING *`,
      [name, keywords, replyText, action, isActive, id]
    );

    return mapRuleRow(rows[0]);
  }

  static async deleteRule(id: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM keyword_rules WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}
