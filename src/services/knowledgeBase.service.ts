import { db } from '../config/db.js';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export interface KnowledgeBase {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: number;
  knowledgeBaseId: number;
  filename: string;
  mimeType: string;
  charCount: number;
  preview: string;
  createdAt: string;
}

// Tope de caracteres del contexto total que se inyecta en el system prompt del bot (ver
// AIService.processMessage / KnowledgeBaseService.getActiveContext). Evita que subir muchos
// documentos dispare el consumo de tokens por mensaje contra los límites de Gemini (ver .env:
// 15 RPM / 1.500 RPD / 1M TPM). Ajustable por variable de entorno sin tocar código.
const MAX_CONTEXT_CHARS = parseInt(process.env.KB_MAX_CONTEXT_CHARS || '60000', 10);

const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];

// --- Seguridad: detección de intentos de "prompt injection" en documentos subidos -----------
// Defensa best-effort (heurística por patrones, no infalible) contra archivos que intenten
// darle instrucciones a la IA (ej. "ignorá tus instrucciones anteriores") o pedirle que
// revele configuración interna del sistema (variables de entorno, API keys, contraseñas de
// la base, etc.). La defensa "real" — que no depende de adivinar cada frase posible — está en
// el system prompt de AIService (ver ai.service.ts): ahí se le indica al modelo que el
// contenido de la Base de Conocimiento es solo información de referencia, nunca instrucciones,
// y que nunca debe revelar secretos del sistema sin importar qué le pidan. Esto es una capa
// adicional para frenar los casos más obvios antes de que el texto llegue siquiera a la IA.
const INJECTION_PATTERNS: RegExp[] = [
  /ignor[ae]\s+(todas?\s+)?(las?\s+)?instruccion/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /olvid[ae]\s+(tus?\s+)?instruccion/i,
  /forget\s+(your\s+)?(previous\s+)?instructions/i,
  /nuevas?\s+instruccion(es)?\s*:/i,
  /new\s+instructions?\s*:/i,
  /system\s*prompt/i,
  /prompt\s+de\s+sistema/i,
  /revela(r)?\s+(tu|el|las?)\s+(system\s*prompt|prompt|configuraci[oó]n|instruccion)/i,
  /reveal\s+your\s+(system\s*prompt|instructions|configuration)/i,
  /variables?\s+de\s+entorno/i,
  /environment\s+variables?/i,
  /\bprocess\.env\b/i,
  /\b[A-Z_]{3,}_(API_KEY|SECRET|PASSWORD|TOKEN)\b/, // ej. GEMINI_API_KEY, PG_PASSWORD, JWT_SECRET
  /modo\s+desarrollador/i,
  /developer\s+mode/i,
  /\bjailbreak\b/i,
  /act\s+as\s+(if\s+you\s+have\s+no|an?\s+ai\s+with\s+no)\s+restrictions/i,
  /act[uú]a\s+como\s+(si\s+no\s+tuvieras|un[a]?\s+ia\s+sin)\s+(l[ií]mites|restricciones)/i,
];

/**
 * Busca patrones de "prompt injection" en un texto ya extraído. Devuelve el patrón que
 * coincidió (para loguear), o null si no encontró nada sospechoso.
 */
function detectInjectionAttempt(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

function mapBaseRow(row: any): KnowledgeBase {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapDocRow(row: any): KnowledgeDocument {
  const content: string = row.content || '';
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    filename: row.filename,
    mimeType: row.mime_type,
    charCount: row.char_count,
    preview: content.slice(0, 200),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class KnowledgeBaseService {
  // --- Bases de conocimiento ---------------------------------------------------------------

  static async listBases(): Promise<KnowledgeBase[]> {
    const { rows } = await db.query('SELECT * FROM knowledge_bases ORDER BY created_at DESC');
    return rows.map(mapBaseRow);
  }

  static async getBase(id: number): Promise<KnowledgeBase | null> {
    const { rows } = await db.query('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    return mapBaseRow(rows[0]);
  }

  static async createBase(data: { title: string; description?: string; isActive?: boolean }): Promise<KnowledgeBase> {
    const title = data.title.trim();
    const description = (data.description || '').trim();
    const isActive = data.isActive !== undefined ? data.isActive : true;

    const { rows } = await db.query(
      `INSERT INTO knowledge_bases (title, description, is_active) VALUES ($1, $2, $3) RETURNING *`,
      [title, description, isActive]
    );
    return mapBaseRow(rows[0]);
  }

  static async updateBase(
    id: number,
    data: Partial<{ title: string; description: string; isActive: boolean }>
  ): Promise<KnowledgeBase | null> {
    const existing = await this.getBase(id);
    if (!existing) return null;

    const title = data.title !== undefined ? data.title.trim() : existing.title;
    const description = data.description !== undefined ? data.description.trim() : existing.description;
    const isActive = data.isActive !== undefined ? data.isActive : existing.isActive;

    const { rows } = await db.query(
      `UPDATE knowledge_bases SET title = $1, description = $2, is_active = $3 WHERE id = $4 RETURNING *`,
      [title, description, isActive, id]
    );
    return mapBaseRow(rows[0]);
  }

  static async deleteBase(id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  // --- Documentos ----------------------------------------------------------------------------

  static async listDocuments(knowledgeBaseId: number): Promise<KnowledgeDocument[]> {
    const { rows } = await db.query(
      'SELECT * FROM knowledge_documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC',
      [knowledgeBaseId]
    );
    return rows.map(mapDocRow);
  }

  static async deleteDocument(id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM knowledge_documents WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Extrae el texto plano de un archivo subido según su extensión. PDF y DOCX no son texto
   * plano: hay que parsearlos de verdad (no alcanza con buffer.toString('utf-8'), eso solo
   * sirve para .txt/.md).
   */
  static async extractText(filename: string, buffer: Buffer): Promise<string> {
    const ext = (filename.toLowerCase().split('.').pop() || '').trim();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Tipo de archivo no soportado: .${ext || '?'}. Usá PDF, Word (.docx), .txt o .md.`);
    }

    if (ext === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        // pdf-parse agrega separadores tipo "-- 1 of 2 --" entre páginas; los sacamos.
        return result.text.replace(/^-- \d+ of \d+ --$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      } finally {
        await parser.destroy();
      }
    }

    if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }

    // txt / md
    return buffer.toString('utf-8').trim();
  }

  static async addDocument(knowledgeBaseId: number, filename: string, buffer: Buffer, mimeType: string): Promise<KnowledgeDocument> {
    const base = await this.getBase(knowledgeBaseId);
    if (!base) throw new Error('Base de conocimiento no encontrada');

    const content = await this.extractText(filename, buffer);
    if (!content) {
      throw new Error('No se pudo extraer texto del archivo (¿está vacío o es un PDF escaneado sin texto/OCR?)');
    }

    const injectionMatch = detectInjectionAttempt(content);
    if (injectionMatch) {
      console.warn(`⚠️ [KnowledgeBaseService] Documento "${filename}" rechazado por contenido sospechoso (patrón: ${injectionMatch})`);
      throw new Error(
        'El documento fue rechazado: contiene texto que parece un intento de darle instrucciones a la IA o de pedirle que revele configuración interna del sistema (ej. "ignorá tus instrucciones", variables de entorno, API keys, contraseñas). Si es un falso positivo, revisá el archivo y quitá esa frase antes de volver a subirlo.'
      );
    }

    const { rows } = await db.query(
      `INSERT INTO knowledge_documents (knowledge_base_id, filename, content, mime_type, char_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [knowledgeBaseId, filename, content, mimeType, content.length]
    );
    return mapDocRow(rows[0]);
  }

  /**
   * Concatena el texto de todos los documentos de todas las bases ACTIVAS (una sola base de
   * conocimiento global para toda la empresa por ahora, sin filtrar por usuario — no hay auth
   * todavía, ver Issue #6). Se inyecta en el system prompt del bot desde
   * AIService.processMessage. Trunca a MAX_CONTEXT_CHARS para no disparar el consumo de tokens
   * por mensaje.
   */
  static async getActiveContext(): Promise<string> {
    const { rows } = await db.query(
      `SELECT kb.title AS base_title, d.filename, d.content
       FROM knowledge_documents d
       JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
       WHERE kb.is_active = true
       ORDER BY kb.created_at ASC, d.created_at ASC`
    );

    if (rows.length === 0) return '';

    let context = '';
    let truncated = false;
    for (const row of rows) {
      const block = `=== Base: ${row.base_title} — Documento: ${row.filename} ===\n${row.content}\n\n`;
      if (context.length + block.length > MAX_CONTEXT_CHARS) {
        truncated = true;
        break;
      }
      context += block;
    }

    if (truncated) {
      console.warn(`⚠️ [KnowledgeBaseService] Contexto truncado en ${MAX_CONTEXT_CHARS} caracteres (KB_MAX_CONTEXT_CHARS). Subiste más documentos de los que entran en el límite configurado.`);
    }

    return context.trim();
  }
}
