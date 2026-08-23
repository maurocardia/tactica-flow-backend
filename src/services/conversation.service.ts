import { db } from '../config/db.js';

export type MessageSender = 'customer' | 'agent' | 'bot';
export type ConversationStatus = 'active' | 'bot' | 'resolved';

export interface ConversationMessage {
  id: number;
  conversationId: number;
  sender: MessageSender;
  text: string;
  createdAt: string; // ISO timestamp
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
  };
}

function mapMessageRow(row: any): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
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
  static async findOrCreateByPhone(phone: string, name: string, userId: number): Promise<Conversation> {
    const existing = await db.query(
      'SELECT * FROM conversations WHERE phone = $1 AND user_id = $2',
      [phone, userId]
    );

    if (existing.rows.length > 0) {
      return mapConversationRow(existing.rows[0]);
    }

    const { rows } = await db.query(
      `INSERT INTO conversations (name, phone, tag, status, user_id)
       VALUES ($1, $2, $3, 'bot', $4) RETURNING *`,
      [name, phone, 'WhatsApp', userId]
    );

    return mapConversationRow(rows[0]);
  }

  static async addMessage(
    conversationId: number,
    sender: MessageSender,
    text: string
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
        `INSERT INTO messages (conversation_id, sender, text) VALUES ($1, $2, $3) RETURNING *`,
        [conversationId, sender, text]
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
