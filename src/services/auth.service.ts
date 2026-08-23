import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { db } from '../config/db.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export interface GoogleTokenPayload {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface User {
  id: number;
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  whatsappChannel: string;
  aiProvider: string;
  aiModel: string;
  createdAt: string;
  updatedAt: string;
}

function mapUserRow(row: any): User {
  return {
    id: row.id,
    googleId: row.google_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    whatsappChannel: row.whatsapp_channel,
    aiProvider: row.ai_provider,
    aiModel: row.ai_model,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class AuthService {
  static async verifyGoogleToken(idToken: string): Promise<GoogleTokenPayload> {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email || !payload.name) {
      throw new Error('Token de Google inválido: falta información del usuario');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };
  }

  static async findOrCreateUser(payload: GoogleTokenPayload): Promise<User> {
    const existing = await db.query(
      'SELECT * FROM users WHERE google_id = $1 OR email = $2',
      [payload.sub, payload.email]
    );

    if (existing.rows.length > 0) {
      return mapUserRow(existing.rows[0]);
    }

    const { rows } = await db.query(
      `INSERT INTO users (google_id, email, name, avatar_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [payload.sub, payload.email, payload.name, payload.picture || null]
    );

    return mapUserRow(rows[0]);
  }

  static async getUserById(id: number): Promise<User | null> {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  static generateJwt(user: User): string {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );
  }
}
