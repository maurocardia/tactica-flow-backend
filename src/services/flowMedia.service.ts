import { db } from '../config/db.js';

// Adjuntos multimedia de los bloques de flujo (Enviar Imagen/Video/Audio/Documento) — ver
// flow_media_assets en db.ts. Los bytes viven en Postgres (BYTEA) y se cargan en proceso al
// mandar el mensaje (ver whatsapp.service.ts) en vez de exponer una URL pública: el backend no
// necesita ser alcanzable desde internet para que Baileys pueda adjuntar el archivo.
export interface FlowMediaAsset {
  id: number;
  userId: number;
  kind: 'image' | 'video' | 'audio' | 'document';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface FlowMediaAssetWithData extends FlowMediaAsset {
  data: Buffer;
}

const ALLOWED_MIME_BY_KIND: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/3gpp', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/amr'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
  ],
};

function mapRow(row: any): FlowMediaAsset {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class FlowMediaService {
  static isMimeAllowed(kind: string, mimeType: string): boolean {
    const allowed = ALLOWED_MIME_BY_KIND[kind];
    return Array.isArray(allowed) && allowed.includes(mimeType);
  }

  static async create(userId: number, kind: string, fileName: string, mimeType: string, data: Buffer): Promise<FlowMediaAsset> {
    const { rows } = await db.query(
      `INSERT INTO flow_media_assets (user_id, kind, file_name, mime_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, user_id, kind, file_name, mime_type, size_bytes, created_at`,
      [userId, kind, fileName, mimeType, data.length, data]
    );
    return mapRow(rows[0]);
  }

  static async list(userId: number): Promise<FlowMediaAsset[]> {
    const { rows } = await db.query(
      `SELECT id, user_id, kind, file_name, mime_type, size_bytes, created_at
       FROM flow_media_assets WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map(mapRow);
  }

  /** Con los bytes — usado tanto para servir el preview (rutas) como para adjuntar al enviar (whatsapp.service.ts). */
  static async getByIdWithData(userId: number, id: number): Promise<FlowMediaAssetWithData | null> {
    const { rows } = await db.query(
      `SELECT id, user_id, kind, file_name, mime_type, size_bytes, created_at, data
       FROM flow_media_assets WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rows.length === 0) return null;
    return { ...mapRow(rows[0]), data: rows[0].data };
  }

  static async delete(userId: number, id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM flow_media_assets WHERE id = $1 AND user_id = $2', [id, userId]);
    return (rowCount ?? 0) > 0;
  }
}
