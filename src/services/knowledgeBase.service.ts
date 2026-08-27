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
   * IDs de las bases activas ahora mismo — versión liviana de getActiveContext() para cuando
   * solo hace falta filtrar (ver ConversationService.toAiHistory), sin traer el contenido de
   * los documentos.
   */
  static async getActiveBaseIds(): Promise<number[]> {
    const { rows } = await db.query('SELECT id FROM knowledge_bases WHERE is_active = true');
    return rows.map((r) => r.id);
  }

  /**
   * Obtiene el contexto de las bases de conocimiento ACTIVAS de forma optimizada.
   * Si el texto acumulado es grande, aplica un filtro de relevancia (RAG ligero) extrayendo
   * los fragmentos que mejor responden a la consulta del usuario, reduciendo el consumo de
   * tokens en hasta un 95% y evitando exceder límites de cuota (TPM).
   */
  static async getActiveContext(query?: string): Promise<{ context: string; baseIds: number[] }> {
    const { rows } = await db.query(
      `SELECT kb.id AS base_id, kb.title AS base_title, d.filename, d.content
       FROM knowledge_documents d
       JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
       WHERE kb.is_active = true
       ORDER BY kb.created_at ASC, d.created_at ASC`
    );

    if (rows.length === 0) return { context: '', baseIds: [] };

    const baseIds = new Set<number>();
    rows.forEach((r) => baseIds.add(r.base_id));

    let totalLength = 0;
    rows.forEach((r) => (totalLength += (r.content || '').length));

    // Si el contenido total es pequeño (<= 14.000 caracteres, ~3.500 tokens) o no hay query, enviamos todo directo
    if (totalLength <= 14000 || !query || !query.trim()) {
      let context = '';
      for (const row of rows) {
        context += `=== Base: ${row.base_title} — Documento: ${row.filename} ===\n${row.content}\n\n`;
      }
      return { context: context.trim(), baseIds: [...baseIds] };
    }

    // --- Filtro de Relevancia Semántica y Palabras Clave (RAG Ligero) ---
    const STOPWORDS = new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al', 'en', 'para', 'por', 'con',
      'sin', 'sobre', 'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'cuanto', 'este', 'esta', 'estos', 'estas',
      'hola', 'buenas', 'dias', 'tardes', 'noches', 'favor', 'gracias', 'porfa', 'podrias', 'puedes', 'tienen',
      'hay', 'ser', 'estar', 'hacer', 'mi', 'tu', 'su', 'nos', 'me', 'te', 'se', 'le', 'les', 'lo', 'y', 'o', 'pero'
    ]);

    const queryKeywords = query
      .toLowerCase()
      .replace(/[^\w\sáéíóúüñ]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    interface Chunk {
      baseTitle: string;
      filename: string;
      text: string;
      score: number;
    }

    const chunks: Chunk[] = [];

    for (const row of rows) {
      const content = row.content || '';
      const rawParagraphs = content.split(/\n\s*\n/);
      const docChunks: string[] = [];

      let current = '';
      for (const p of rawParagraphs) {
        if ((current + '\n' + p).length > 700) {
          if (current.trim()) docChunks.push(current.trim());
          current = p;
        } else {
          current = current ? `${current}\n${p}` : p;
        }
      }
      if (current.trim()) docChunks.push(current.trim());

      for (const chunkText of docChunks) {
        const chunkLower = chunkText.toLowerCase();
        let score = 0;

        if (queryKeywords.length === 0) {
          score = 1;
        } else {
          for (const kw of queryKeywords) {
            const matches = (chunkLower.match(new RegExp(`\\b${kw}`, 'g')) || []).length;
            score += matches * 10;
            if (matches === 0 && chunkLower.includes(kw)) {
              score += 3;
            }
          }
        }

        chunks.push({
          baseTitle: row.base_title,
          filename: row.filename,
          text: chunkText,
          score
        });
      }
    }

    chunks.sort((a, b) => b.score - a.score);

    let selectedLength = 0;
    const selectedChunks: Chunk[] = [];
    const MAX_FILTERED_CHARS = 12000;

    for (const c of chunks) {
      if (c.score === 0 && selectedChunks.length >= 2) break;
      if (selectedLength + c.text.length > MAX_FILTERED_CHARS) break;
      selectedChunks.push(c);
      selectedLength += c.text.length;
    }

    if (selectedChunks.length === 0 && chunks.length > 0) {
      selectedChunks.push(...chunks.slice(0, 3));
    }

    let context = '';
    for (const sc of selectedChunks) {
      context += `=== Base: ${sc.baseTitle} — Documento: ${sc.filename} ===\n${sc.text}\n\n`;
    }

    console.log(
      `⚡ [KnowledgeBaseService] Contexto optimizado para IA: ${selectedLength} chars (~${Math.round(selectedLength / 4)} tokens) seleccionados de ${totalLength} chars totales.`
    );

    return { context: context.trim(), baseIds: [...baseIds] };
  }
}
