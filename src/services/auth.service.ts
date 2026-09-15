import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { db } from '../config/db.js';

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
  botEnabled: boolean;
  aiFallbackEnabled: boolean;
  aiCustomInstructions: string;
  aiPromptConfig: AiPromptConfig | null;
  botEnabledForNewContacts: boolean;
  botReplyToAll: boolean;
  createdAt: string;
  updatedAt: string;
}

// Mismo desglose de apartados que arma el modal (ver AiAgentConfigModal.tsx) — se guarda tal cual
// para que la UI pueda reabrirse sin perder qué switches de "Reglas generales" estaban prendidos.
export interface AiPromptSections {
  behavior: string;
  objective: string;
  rules: string;
  tone: string;
  companyInfo: string;
  callToAction: string;
  notes: string;
}

export interface AiGeneralRules {
  mainLanguage: string;
  followClientLanguage: boolean;
  noSwearing: boolean;
  neverInvent: boolean;
  shortAnswers: boolean;
  focusOnCompany: boolean;
  addressByFirstName: boolean;
  noSpecialCharacters: boolean;
  noEmojis: boolean;
  offerHumanAgent: boolean;
  protectSensitiveData: boolean;
}

export interface AiPromptConfig {
  sections: AiPromptSections;
  generalRules: AiGeneralRules;
}

const SECTION_LABELS: Record<keyof AiPromptSections, string> = {
  behavior: 'Comportamiento del asistente',
  objective: 'Objetivo principal',
  rules: 'Reglas absolutas',
  tone: 'Tono de voz',
  companyInfo: 'Información de la empresa',
  callToAction: 'Llamado a la acción',
  notes: 'Notas adicionales',
};

const LANGUAGE_LABEL: Record<string, string> = {
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  en: 'English',
};

// Traduce los switches activados a instrucciones concretas — una regla en "off" simplemente no
// agrega ninguna línea (no hace falta aclarar la ausencia de una restricción). Misma lógica que
// el frontend (AiAgentConfigModal.tsx) para que lo que se ve en el modal sea exactamente lo que
// termina en el prompt real del bot.
function buildGeneralRulesText(rules: AiGeneralRules): string {
  const lines: string[] = [`Responder siempre en ${LANGUAGE_LABEL[rules.mainLanguage] || rules.mainLanguage}.`];
  if (rules.followClientLanguage) lines.push('Si el cliente escribe en otro idioma, responder en el idioma del cliente.');
  if (rules.noSwearing) lines.push('No usar malas palabras ni lenguaje ofensivo.');
  if (rules.neverInvent) lines.push('Nunca inventar información que no esté confirmada.');
  if (rules.shortAnswers) lines.push('Mantener las respuestas cortas y directas.');
  if (rules.focusOnCompany) lines.push('Mantener el foco en temas relacionados a la empresa.');
  if (rules.addressByFirstName) lines.push('Llamar al cliente por su primer nombre cuando se sepa.');
  if (rules.noSpecialCharacters) lines.push('No usar caracteres especiales ni formato markdown.');
  if (rules.noEmojis) lines.push('No usar emojis.');
  if (rules.offerHumanAgent) lines.push('Si no se puede resolver la consulta, ofrecer derivar a un atendente humano.');
  if (rules.protectSensitiveData) lines.push('Nunca compartir ni pedir datos sensibles (contraseñas, tarjetas, etc.) del cliente.');
  return lines.join(' ');
}

// Junta los apartados de texto libre + "Reglas generales" en el único texto que de verdad lee el
// bot (ai_custom_instructions) — se compone acá, del lado del servidor, para que sea la misma
// función la que arma el prompt sin importar desde dónde se guarde.
export function composeAiPrompt(config: AiPromptConfig): string {
  const order: (keyof AiPromptSections)[] = ['behavior', 'objective', 'rules'];
  const lines = order
    .map((key) => (config.sections[key]?.trim() ? `${SECTION_LABELS[key]}: ${config.sections[key].trim()}` : ''))
    .filter(Boolean);
  lines.push(`Reglas generales: ${buildGeneralRulesText(config.generalRules)}`);
  (['tone', 'companyInfo', 'callToAction', 'notes'] as (keyof AiPromptSections)[]).forEach((key) => {
    if (config.sections[key]?.trim()) lines.push(`${SECTION_LABELS[key]}: ${config.sections[key].trim()}`);
  });
  return lines.join('\n');
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
    botEnabled: row.bot_enabled,
    aiFallbackEnabled: row.ai_fallback_enabled,
    aiCustomInstructions: row.ai_custom_instructions,
    aiPromptConfig: row.ai_prompt_config ?? null,
    botEnabledForNewContacts: row.bot_enabled_for_new_contacts,
    botReplyToAll: row.bot_reply_to_all,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class AuthService {
  static async verifyGoogleToken(idToken: string): Promise<GoogleTokenPayload> {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      throw new Error('GOOGLE_CLIENT_ID no está configurado en el archivo .env del backend');
    }
    const client = new OAuth2Client(googleClientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: googleClientId,
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

  static async setBotEnabled(id: number, botEnabled: boolean): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET bot_enabled = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [botEnabled, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  static async setAiFallbackEnabled(id: number, aiFallbackEnabled: boolean): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET ai_fallback_enabled = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [aiFallbackEnabled, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  static async setAiCustomInstructions(id: number, aiCustomInstructions: string): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET ai_custom_instructions = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [aiCustomInstructions, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  // Guarda la config estructurada del Agente IA (apartados + Reglas generales) Y el texto final
  // compuesto en la misma operación — así el prompt que de verdad usa el bot (ai_custom_instructions)
  // nunca queda desincronizado de lo que el usuario ve/edita en el modal.
  static async setAiPromptConfig(id: number, config: AiPromptConfig): Promise<User | null> {
    const composed = composeAiPrompt(config);
    const { rows } = await db.query(
      `UPDATE users SET ai_prompt_config = $1, ai_custom_instructions = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [JSON.stringify(config), composed, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  static async setBotEnabledForNewContacts(id: number, enabled: boolean): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET bot_enabled_for_new_contacts = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [enabled, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  static async setBotReplyToAll(id: number, enabled: boolean): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET bot_reply_to_all = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [enabled, id]
    );
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
