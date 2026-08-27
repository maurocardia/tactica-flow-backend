import { db } from '../config/db.js';

export type MessageSender = 'customer' | 'agent' | 'bot';
export type ConversationStatus = 'active' | 'bot' | 'resolved';

export interface ConversationMessage {
  id: number;
  conversationId: number;
  sender: MessageSender;
  text: string;
  createdAt: string; // ISO timestamp
  // Bases de conocimiento activas en el momento en que se generó este mensaje (vacío para
  // mensajes del cliente, respuestas por regla fija, o respuestas de IA sin ninguna base
  // activa). Ver toAiHistory().
  sourceKbIds: number[];
}

export interface Conversation {
  id: number;
  name: string;
  phone: string;
  lastMsg: string;
  lastMessageAt: string; // ISO timestamp
  unread: number;
  tag: string;
  status: ConversationStatus;
  userId: number | null;
  // Nombre del grupo de WhatsApp si esta conversación es la de un participante puntual dentro
  // de un grupo (ver WhatsappService.handleIncomingMessage) — null en chats individuales.
  groupName: string | null;
}

// --- Row -> domain object mapping (Postgres devuelve snake_case) ---

function mapConversationRow(row: any): Conversation {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    lastMsg: row.last_msg,
    lastMessageAt: new Date(row.last_message_at).toISOString(),
    unread: row.unread,
    tag: row.tag,
    status: row.status,
    userId: row.user_id,
    groupName: row.group_name,
  };
}

function mapMessageRow(row: any): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
    sourceKbIds: row.source_kb_ids ?? [],
  };
}

export class ConversationService {
  /**
   * Siembra las 3 conversaciones de demo (con las que ya arrancaba la app en memoria) la
   * primera vez que se corre contra una base vacía. Se llama una vez al arrancar el servidor,
   * después de initDatabase(). No hace nada si ya hay conversaciones (para no duplicar en
   * cada reinicio).
   */
  static async seedIfEmpty(): Promise<void> {
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM conversations');
    if (rows[0].count > 0) return;

    const now = new Date();
    const today = (h: number, m: number) => {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      return d;
    };
    const yesterday = (h: number, m: number) => {
      const d = today(h, m);
      d.setDate(d.getDate() - 1);
      return d;
    };

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const conv1 = await client.query(
        `INSERT INTO conversations (name, phone, last_msg, last_message_at, unread, tag, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        ['Juan Pérez (Distribuidora Sur)', '+54 9 11 4567-8901', 'Necesito consultar el stock de cajas de agua', today(12, 34), 2, 'Cliente VIP', 'bot']
      );
      const conv1Id = conv1.rows[0].id;
      await client.query(
        `INSERT INTO messages (conversation_id, sender, text, created_at) VALUES
         ($1, 'customer', $2, $3),
         ($1, 'bot', $4, $3),
         ($1, 'customer', $5, $6)`,
        [
          conv1Id,
          'Hola buenas tardes, necesito hacer una consulta urgente.',
          today(12, 30),
          '¡Hola! Soy el asistente IA de Tactica Flow. ¿En qué puedo ayudarte hoy?',
          'Necesito consultar el stock de 30 cajas de agua mineral para registrar un pedido.',
          today(12, 34),
        ]
      );

      const conv2 = await client.query(
        `INSERT INTO conversations (name, phone, last_msg, last_message_at, unread, tag, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        ['María Gómez (Logística Global)', '+54 9 11 9876-5432', 'Perfecto, quedo a la espera del presupuesto', today(11, 15), 0, 'Cotización', 'active']
      );
      await client.query(
        `INSERT INTO messages (conversation_id, sender, text, created_at) VALUES ($1, 'customer', $2, $3)`,
        [conv2.rows[0].id, 'Perfecto, quedo a la espera del presupuesto', today(11, 15)]
      );

      const conv3 = await client.query(
        `INSERT INTO conversations (name, phone, last_msg, last_message_at, unread, tag, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        ['Carlos Rodríguez', '+54 9 11 3333-2222', 'Se me rompió la cafetera de oficina', yesterday(14, 0), 0, 'Soporte', 'resolved']
      );
      await client.query(
        `INSERT INTO messages (conversation_id, sender, text, created_at) VALUES ($1, 'customer', $2, $3)`,
        [conv3.rows[0].id, 'Se me rompió la cafetera de oficina', yesterday(14, 0)]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async listConversations(): Promise<Conversation[]> {
    const { rows } = await db.query('SELECT * FROM conversations ORDER BY last_message_at DESC');
    return rows.map(mapConversationRow);
  }

  static async getMessages(conversationId: number): Promise<ConversationMessage[] | null> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) return null;

    const { rows } = await db.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );
    return rows.map(mapMessageRow);
  }

  /**
   * Convierte los últimos mensajes guardados de una conversación al formato de historial que
   * espera AIService.processMessage: 'customer' -> 'user', y tanto 'agent' como 'bot' -> 'assistant'
   * (desde el punto de vista del modelo, cualquier mensaje ya enviado al cliente es un turno
   * propio, sin importar si lo tipeó un humano o el bot). Se limita a los últimos `limit`
   * mensajes para no disparar el consumo de tokens en conversaciones largas.
   *
   * Filtra respuestas del bot que dicen "no tengo información" o "no tengo una base de
   * conocimiento" para evitar que contaminen futuras respuestas de la IA (si el bot respondió
   * mal antes de que la KB estuviera cargada, esos mensajes no deben influir en respuestas
   * posteriores).
   */
  private static readonly POISONED_PATTERNS = [
    /no tengo informaci[oó]n sobre eso/i,
    /no tengo una base de conocimiento/i,
    /actualmente no tengo una base de conocimiento/i,
    /no cuento con informaci[oó]n/i,
    /no dispongo de informaci[oó]n/i,
  ];

  /**
   * `activeBaseIds` son las bases de conocimiento activas AHORA (ver
   * KnowledgeBaseService.getActiveBaseIds/getActiveContext). Un mensaje del bot generado usando
   * una o más bases (msg.sourceKbIds) se descarta del historial si NINGUNA de esas bases sigue
   * activa: su contenido ya no es válido y no debe seguir "pesando" en la conversación (ej. el
   * bot no debe seguir hablando de productos de una base que se desactivó). Los mensajes del
   * cliente y las respuestas sin base asociada (reglas fijas, saludos genéricos) siempre se
   * conservan — así la charla sigue siendo continua y reconoce al contacto en vez de arrancar de
   * cero cada vez.
   */
  static toAiHistory(
    messages: ConversationMessage[],
    activeBaseIds: number[] = [],
    limit = 20
  ): { role: 'user' | 'assistant'; content: string }[] {
    const activeSet = new Set(activeBaseIds);
    const filtered = messages.filter((msg) => {
      if (msg.sender === 'bot' || msg.sender === 'agent') {
        if (ConversationService.POISONED_PATTERNS.some((p) => p.test(msg.text))) return false;
        if (msg.sourceKbIds.length > 0 && !msg.sourceKbIds.some((id) => activeSet.has(id))) return false;
      }
      return true;
    });
    return filtered.slice(-limit).map((msg) => ({
      role: msg.sender === 'customer' ? 'user' : 'assistant',
      content: msg.text,
    }));
  }

  static async getConversation(conversationId: number): Promise<Conversation | null> {
    const { rows } = await db.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (rows.length === 0) return null;
    return mapConversationRow(rows[0]);
  }

  /**
   * Usado por whatsapp.service.ts cuando llega un mensaje de un número que todavía no tiene
   * conversación para ese usuario: la crea en el Inbox automáticamente, en modo `bot` (la está
   * atendiendo el motor del bot, no un agente humano). Si ya existe, la devuelve tal cual.
   */
  static async findOrCreateByPhone(
    phone: string,
    name: string,
    userId: number,
    groupName: string | null = null
  ): Promise<Conversation> {
    const existing = await db.query(
      'SELECT * FROM conversations WHERE phone = $1 AND user_id = $2',
      [phone, userId]
    );

    if (existing.rows.length > 0) {
      const current = mapConversationRow(existing.rows[0]);
      // Backfill: conversaciones creadas antes de que existiera group_name (o si el grupo
      // cambió de nombre en WhatsApp) se actualizan acá en vez de quedar desactualizadas para
      // siempre — si no, listByGroupName() nunca las encuentra aunque el grupo sea el mismo.
      if (groupName && current.groupName !== groupName) {
        const { rows } = await db.query(
          `UPDATE conversations SET group_name = $1 WHERE id = $2 RETURNING *`,
          [groupName, current.id]
        );
        return mapConversationRow(rows[0]);
      }
      return current;
    }

    const { rows } = await db.query(
      `INSERT INTO conversations (name, phone, tag, status, user_id, group_name)
       VALUES ($1, $2, $3, 'bot', $4, $5) RETURNING *`,
      [name, phone, 'WhatsApp', userId, groupName]
    );

    return mapConversationRow(rows[0]);
  }

  /**
   * Todas las conversaciones (una por participante) que pertenecen al mismo grupo real de
   * WhatsApp, para el usuario dado. Usado por AiSummaryModal en el panel: en vez de leer la
   * pantalla para adivinar quién escribió qué, resume con los datos reales guardados acá.
   */
  static async listByGroupName(groupName: string, userId: number): Promise<Conversation[]> {
    const { rows } = await db.query(
      'SELECT * FROM conversations WHERE group_name = $1 AND user_id = $2 ORDER BY name ASC',
      [groupName, userId]
    );
    return rows.map(mapConversationRow);
  }

  static async addMessage(
    conversationId: number,
    sender: MessageSender,
    text: string,
    sourceKbIds: number[] = []
  ): Promise<{ message: ConversationMessage; conversation: Conversation } | null> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const convResult = await client.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      if (convResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const msgResult = await client.query(
        `INSERT INTO messages (conversation_id, sender, text, source_kb_ids) VALUES ($1, $2, $3, $4) RETURNING *`,
        [conversationId, sender, text, sourceKbIds]
      );

      const unreadDelta = sender === 'customer' ? convResult.rows[0].unread + 1 : sender === 'agent' ? 0 : convResult.rows[0].unread;

      const updatedConvResult = await client.query(
        `UPDATE conversations SET last_msg = $1, last_message_at = $2, unread = $3 WHERE id = $4 RETURNING *`,
        [text, msgResult.rows[0].created_at, unreadDelta, conversationId]
      );

      await client.query('COMMIT');

      return {
        message: mapMessageRow(msgResult.rows[0]),
        conversation: mapConversationRow(updatedConvResult.rows[0]),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
