import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { db } from '../config/db.js';

export interface GoogleTokenPayload {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

// Agente de IA Modular (Issue #21/#25 [EPIC #10]): reemplaza el textarea único de
// ai_custom_instructions por apartados de texto libre + switches de "Reglas generales" — ver
// AiAgentConfigModal.tsx (frontend) y AuthService.composeAiPrompt más abajo, que traduce esto a
// un único texto y lo guarda en ai_custom_instructions (el bot en background no cambia).
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

const SECTION_LABELS: { key: keyof AiPromptSections; label: string }[] = [
  { key: 'behavior', label: 'Comportamiento del asistente' },
  { key: 'objective', label: 'Objetivo principal' },
  { key: 'rules', label: 'Reglas absolutas' },
  { key: 'tone', label: 'Tono de voz' },
  { key: 'companyInfo', label: 'Información de la empresa' },
  { key: 'callToAction', label: 'Llamado a la acción' },
  { key: 'notes', label: 'Notas adicionales' },
];

const LANGUAGE_NAME: Record<string, string> = { es: 'español', 'pt-BR': 'portugués de Brasil', en: 'inglés' };

const GENERAL_RULE_TEXT: Record<Exclude<keyof AiGeneralRules, 'mainLanguage'>, string> = {
  followClientLanguage: 'Si el cliente escribe en otro idioma, respondé en ese idioma en vez del idioma principal configurado.',
  noSwearing: 'No uses groserías ni lenguaje ofensivo bajo ninguna circunstancia.',
  neverInvent: 'Nunca inventes información (precios, stock, plazos, políticas) que no tengas confirmada.',
  shortAnswers: 'Mantené las respuestas cortas y directas, evitando párrafos largos.',
  focusOnCompany: 'Mantené la conversación enfocada en la empresa y sus productos o servicios.',
  addressByFirstName: 'Dirigite al cliente por su primer nombre cuando lo conozcas.',
  noSpecialCharacters: 'No uses formato markdown (asteriscos, guiones u otros caracteres especiales) en las respuestas.',
  noEmojis: 'No uses emojis en las respuestas.',
  offerHumanAgent: 'Si no podés resolver la consulta, ofrecé derivar la conversación a un agente humano.',
  protectSensitiveData: 'Nunca pidas ni repitas datos sensibles del cliente (contraseñas, números de tarjeta, documentos de identidad).',
};

// Regla fija de negocio (no editable desde el formulario): nunca desacreditar a la competencia,
// siempre derivar a una demo de Táctica.
const COMPETITOR_RULE = 'Si el cliente menciona competidores (ej. Tango, Dubox, Xubio u otros sistemas de gestión), nunca los desacredites ni hables mal de ellos — mantené un tono profesional y neutral sobre la competencia, y en cambio invitá al cliente a conocer una demo de Táctica para que compare por sí mismo.';

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

  // Preferencia de proveedor/modelo de IA (Issue #8 [EPIC] IA Multi-Provider) — ver
  // AIService.resolveModel para cómo se usa esto al llamar a la IA.
  static async setAiProviderAndModel(id: number, aiProvider: string, aiModel: string): Promise<User | null> {
    const { rows } = await db.query(
      `UPDATE users SET ai_provider = $1, ai_model = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [aiProvider, aiModel, id]
    );
    if (rows.length === 0) return null;
    return mapUserRow(rows[0]);
  }

  // Traduce los apartados + "Reglas generales" del formulario nuevo (ver AiAgentConfigModal.tsx)
  // a un único texto plano — este es el que de verdad lee el bot en background, ver
  // AIService.processMessage / users.ai_custom_instructions.
  static composeAiPrompt(config: AiPromptConfig): string {
    const lines: string[] = [];
    for (const { key, label } of SECTION_LABELS) {
      const value = config.sections[key]?.trim();
      if (value) lines.push(`${label}: ${value}`);
    }

    const { generalRules } = config;
    const ruleLines = [`Hablá principalmente en ${LANGUAGE_NAME[generalRules.mainLanguage] || generalRules.mainLanguage}.`];
    for (const key of Object.keys(GENERAL_RULE_TEXT) as (keyof typeof GENERAL_RULE_TEXT)[]) {
      if (generalRules[key]) ruleLines.push(GENERAL_RULE_TEXT[key]);
    }
    ruleLines.push(COMPETITOR_RULE);
    lines.push(`Reglas generales: ${ruleLines.join(' ')}`);

    return lines.join('\n');
  }

  // Guarda la config estructurada del Agente IA (apartados + Reglas generales) Y el texto final
  // compuesto en la misma operación — así el prompt que de verdad usa el bot (ai_custom_instructions)
  // nunca queda desincronizado de lo que el usuario ve/edita en el modal.
  static async setAiPromptConfig(
    id: number,
    config: AiPromptConfig
  ): Promise<{ aiPromptConfig: AiPromptConfig | null; aiCustomInstructions: string } | null> {
    const composed = AuthService.composeAiPrompt(config);
    const { rows } = await db.query(
      `UPDATE users SET ai_prompt_config = $1, ai_custom_instructions = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [JSON.stringify(config), composed, id]
    );
    if (rows.length === 0) return null;
    const user = mapUserRow(rows[0]);
    return { aiPromptConfig: user.aiPromptConfig, aiCustomInstructions: user.aiCustomInstructions };
  }

  static generateJwt(user: User): string {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );
  }
}
