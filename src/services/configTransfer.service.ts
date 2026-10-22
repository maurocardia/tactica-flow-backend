import { randomUUID } from 'crypto';
import { db } from '../config/db.js';
import { WhatsappService } from './whatsapp.service.js';

// Exportar / importar TODA la configuración de una cuenta en un solo archivo (Configuración →
// "Copia de configuración"), para no tener que armar todo de nuevo en otra cuenta u otro entorno.
// Va todo MENOS la Base de Conocimiento (a pedido: es muy pesada y se carga aparte), y tampoco va
// lo que no es configuración: historial de chats, sesión de WhatsApp, mensajes programados.
//
// Importar REEMPLAZA (réplica exacta), no mezcla: los asesores, las reglas por palabra clave, el
// flujo y sus adjuntos de la cuenta destino se pisan con los del archivo. Ojo: keyword_rules y
// bot_flows son tablas globales del servidor (no por usuario, ver db.ts), así que importarlas
// cambia las de todas las cuentas de ESTE backend — igual que editarlas a mano desde el panel.

export const CONFIG_EXPORT_FORMAT = 'tactica-flow-config';
export const CONFIG_EXPORT_VERSION = 1;

// Los adjuntos del flujo viajan en base64 adentro del JSON. Con más que esto el archivo no entra
// en el límite de 50 MB del body (ver express.json en server.ts) — se exporta sin los bytes y el
// import deja los adjuntos de la cuenta destino como estén (hay que volver a subirlos).
const MAX_MEDIA_EXPORT_BYTES = 25 * 1024 * 1024;

type SettingType = 'boolean' | 'int' | 'text' | 'json';
interface SettingDef {
  key: string;
  column: string;
  type: SettingType;
  oneOf?: string[];
  min?: number;
  max?: number;
}

// Todo lo que se configura por cuenta en `users`. Quedan afuera la identidad (email, nombre,
// google_id, rol) y emergency_stop (es un estado del momento, no una preferencia).
const SETTINGS: SettingDef[] = [
  { key: 'aiProvider', column: 'ai_provider', type: 'text', oneOf: ['google', 'openai', 'anthropic'] },
  { key: 'aiModel', column: 'ai_model', type: 'text' },
  { key: 'botEnabled', column: 'bot_enabled', type: 'boolean' },
  { key: 'aiFallbackEnabled', column: 'ai_fallback_enabled', type: 'boolean' },
  { key: 'aiCustomInstructions', column: 'ai_custom_instructions', type: 'text' },
  { key: 'aiPromptConfig', column: 'ai_prompt_config', type: 'json' },
  { key: 'botGroupsEnabled', column: 'bot_groups_enabled', type: 'boolean' },
  { key: 'botEnabledForNewContacts', column: 'bot_enabled_for_new_contacts', type: 'boolean' },
  { key: 'botReplyToAll', column: 'bot_reply_to_all', type: 'boolean' },
  { key: 'botReplyDelayEnabled', column: 'bot_reply_delay_enabled', type: 'boolean' },
  { key: 'botReplyDelayMinMs', column: 'bot_reply_delay_min_ms', type: 'int', min: 0, max: 600000 },
  { key: 'botReplyDelayMaxMs', column: 'bot_reply_delay_max_ms', type: 'int', min: 0, max: 600000 },
  { key: 'botMode', column: 'bot_mode', type: 'text', oneOf: ['flow_only', 'ai_only', 'hybrid'] },
  { key: 'handoffReservationMinutes', column: 'handoff_reservation_minutes', type: 'int', min: 0, max: 1440 },
  { key: 'queueReminderSeconds', column: 'queue_reminder_seconds', type: 'int', min: 5, max: 86400 },
  { key: 'relayInactivityMinutes', column: 'relay_inactivity_minutes', type: 'int', min: 1, max: 1440 },
  { key: 'advisorFinishKeywords', column: 'advisor_finish_keywords', type: 'text' },
  { key: 'aiPauseAfterAdvisorMinutes', column: 'ai_pause_after_advisor_minutes', type: 'int', min: 0, max: 1440 },
  { key: 'handoffExplicitPhrases', column: 'handoff_explicit_phrases', type: 'text' },
  { key: 'handoffAmbiguousWords', column: 'handoff_ambiguous_words', type: 'text' },
  { key: 'handoffClarifyQuestion', column: 'handoff_clarify_question', type: 'text' },
  { key: 'advisorCounterEnabled', column: 'advisor_counter_enabled', type: 'boolean' },
  { key: 'welcomeMessageEnabled', column: 'welcome_message_enabled', type: 'boolean' },
  { key: 'welcomeMessageText', column: 'welcome_message_text', type: 'text' },
  { key: 'welcomeInactivityMinutes', column: 'welcome_inactivity_minutes', type: 'int', min: 1, max: 43200 },
  { key: 'stopCommandKeyword', column: 'stop_command_keyword', type: 'text' },
  { key: 'stopCommandMinutes', column: 'stop_command_minutes', type: 'int', min: 0, max: 525600 },
];

const RULE_ACTIONS = ['STATIC_REPLY', 'CALL_AI', 'TACTICA_STOCK_LOOKUP', 'CREATE_SUPPORT_TICKET', 'HANDOFF', 'DELAY', 'WEBHOOK'];
const MEDIA_KINDS = ['image', 'video', 'audio', 'document'];

export interface ConfigImportSummary {
  settings: number;
  advisors: number;
  keywordRules: number;
  flow: 'replaced' | 'removed' | 'unchanged';
  flowMedia: number;
  flowMediaSkipped: boolean;
  contacts: number;
  contactsSkipped: boolean;
}

/** undefined = el valor del archivo no sirve para esa columna y se ignora (no rompe el import). */
function coerceSetting(def: SettingDef, value: unknown): unknown {
  if (def.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (def.type === 'int') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(def.max ?? Number.MAX_SAFE_INTEGER, Math.max(def.min ?? 0, Math.round(value)));
  }
  if (def.type === 'text') {
    if (typeof value !== 'string') return undefined;
    if (def.oneOf && !def.oneOf.includes(value)) return undefined;
    return value;
  }
  // json: objeto o null (ai_prompt_config admite NULL = "nunca se guardó desde el formulario").
  if (value === null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : undefined;
}

/** Los nodos de flujo apuntan a sus adjuntos por id (`assetId`) — al importar, los adjuntos se
 * insertan de nuevo y reciben ids distintos, así que hay que reapuntar cada referencia. */
function remapAssetIds(node: unknown, idMap: Map<number, number>): void {
  if (Array.isArray(node)) {
    for (const item of node) remapAssetIds(item, idMap);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (key === 'assetId' && typeof value === 'number' && idMap.has(value)) obj[key] = idMap.get(value);
    else remapAssetIds(value, idMap);
  }
}

export class ConfigTransferService {
  static async exportConfig(userId: number): Promise<Record<string, unknown>> {
    const { rows: userRows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRows.length === 0) throw new Error('Usuario no encontrado');
    const settings: Record<string, unknown> = {};
    for (const def of SETTINGS) settings[def.key] = userRows[0][def.column] ?? null;

    const { rows: advisors } = await db.query(
      'SELECT name, phone, is_active FROM advisors WHERE user_id = $1 ORDER BY lower(name) ASC, id ASC',
      [userId]
    );
    const { rows: rules } = await db.query(
      'SELECT name, keywords, reply_text, action, is_active FROM keyword_rules ORDER BY created_at ASC'
    );
    const { rows: flowRows } = await db.query('SELECT data FROM bot_flows WHERE id = $1', ['main_flow']);

    const { rows: mediaMeta } = await db.query(
      'SELECT id, kind, file_name, mime_type, size_bytes FROM flow_media_assets WHERE user_id = $1 ORDER BY id ASC',
      [userId]
    );
    const totalMediaBytes = mediaMeta.reduce((sum, m) => sum + Number(m.size_bytes || 0), 0);
    const flowMediaSkipped = totalMediaBytes > MAX_MEDIA_EXPORT_BYTES;
    let flowMedia: Record<string, unknown>[] = [];
    if (!flowMediaSkipped && mediaMeta.length > 0) {
      const { rows: mediaRows } = await db.query(
        'SELECT id, kind, file_name, mime_type, data FROM flow_media_assets WHERE user_id = $1 ORDER BY id ASC',
        [userId]
      );
      flowMedia = mediaRows.map((m) => ({
        id: m.id,
        kind: m.kind,
        fileName: m.file_name,
        mimeType: m.mime_type,
        dataBase64: (m.data as Buffer).toString('base64'),
      }));
    }

    // Solo los contactos "configurados" (bot prendido a mano o en Blacklist) del número conectado
    // ahora — el resto de la lista es un espejo de WhatsApp que se rearma solo.
    const ownerJid = WhatsappService.getOwnerJid(userId) || '';
    const { rows: contacts } = ownerJid
      ? await db.query(
          `SELECT jid, name, is_group, bot_enabled, is_blacklisted, lid FROM bot_contacts
           WHERE user_id = $1 AND owner_jid = $2 AND (bot_enabled = true OR is_blacklisted = true)
           ORDER BY id ASC`,
          [userId, ownerJid]
        )
      : { rows: [] as any[] };

    return {
      format: CONFIG_EXPORT_FORMAT,
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      advisors: advisors.map((a) => ({ name: a.name, phone: a.phone, isActive: a.is_active })),
      keywordRules: rules.map((r) => ({
        name: r.name,
        keywords: r.keywords,
        replyText: r.reply_text,
        action: r.action,
        isActive: r.is_active,
      })),
      flow: flowRows.length > 0 ? flowRows[0].data : null,
      flowMedia,
      flowMediaSkipped,
      contacts: contacts.map((c) => ({
        jid: c.jid,
        name: c.name,
        isGroup: c.is_group,
        botEnabled: c.bot_enabled,
        isBlacklisted: c.is_blacklisted,
        lid: c.lid ?? null,
      })),
    };
  }

  /** Todo o nada (una sola transacción): si algo del archivo rompe, la cuenta queda como estaba. */
  static async importConfig(userId: number, payload: any): Promise<ConfigImportSummary> {
    if (!payload || typeof payload !== 'object' || payload.format !== CONFIG_EXPORT_FORMAT) {
      throw new Error('El archivo no es una copia de configuración de Táctica Flow.');
    }
    if (typeof payload.version !== 'number' || payload.version > CONFIG_EXPORT_VERSION) {
      throw new Error('El archivo es de una versión más nueva que este servidor. Actualizá el servidor antes de importarlo.');
    }

    const summary: ConfigImportSummary = {
      settings: 0,
      advisors: 0,
      keywordRules: 0,
      flow: 'unchanged',
      flowMedia: 0,
      flowMediaSkipped: false,
      contacts: 0,
      contactsSkipped: false,
    };

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (payload.settings && typeof payload.settings === 'object') {
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const def of SETTINGS) {
          if (!(def.key in payload.settings)) continue;
          const value = coerceSetting(def, payload.settings[def.key]);
          if (value === undefined) continue;
          values.push(value);
          sets.push(`${def.column} = $${values.length}`);
        }
        if (sets.length > 0) {
          values.push(userId);
          await client.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
          summary.settings = sets.length;
        }
      }

      if (Array.isArray(payload.advisors)) {
        // Los contadores arrancan en cero: son de la cuenta de origen, no de ésta.
        await client.query('DELETE FROM advisors WHERE user_id = $1', [userId]);
        const seenPhones = new Set<string>();
        for (const a of payload.advisors) {
          const name = typeof a?.name === 'string' ? a.name.trim() : '';
          const phone = typeof a?.phone === 'string' ? a.phone.replace(/[^0-9]/g, '') : '';
          if (!name || phone.length < 8 || seenPhones.has(phone)) continue;
          seenPhones.add(phone);
          await client.query('INSERT INTO advisors (user_id, name, phone, is_active) VALUES ($1, $2, $3, $4)', [
            userId,
            name,
            phone,
            a.isActive !== false,
          ]);
          summary.advisors++;
        }
      }

      if (Array.isArray(payload.keywordRules)) {
        await client.query('DELETE FROM keyword_rules');
        let index = 0;
        for (const r of payload.keywordRules) {
          const name = typeof r?.name === 'string' ? r.name.trim() : '';
          const keywords = Array.isArray(r?.keywords) ? r.keywords.filter((k: unknown) => typeof k === 'string' && k.trim()).map((k: string) => k.trim()) : [];
          if (!name || keywords.length === 0) continue;
          // created_at escalonado: el panel las lista por fecha, así conservan el orden del archivo.
          await client.query(
            `INSERT INTO keyword_rules (id, name, keywords, reply_text, action, is_active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval)`,
            [
              randomUUID(),
              name,
              keywords,
              typeof r.replyText === 'string' ? r.replyText : '',
              RULE_ACTIONS.includes(r.action) ? r.action : 'STATIC_REPLY',
              r.isActive !== false,
              index++,
            ]
          );
          summary.keywordRules++;
        }
      }

      // Adjuntos antes que el flujo: el flujo se guarda ya reapuntado a los ids nuevos.
      const assetIdMap = new Map<number, number>();
      if (payload.flowMediaSkipped === true) {
        summary.flowMediaSkipped = true;
      } else if (Array.isArray(payload.flowMedia)) {
        await client.query('DELETE FROM flow_media_assets WHERE user_id = $1', [userId]);
        for (const m of payload.flowMedia) {
          if (!MEDIA_KINDS.includes(m?.kind) || typeof m.dataBase64 !== 'string' || typeof m.mimeType !== 'string') continue;
          const data = Buffer.from(m.dataBase64, 'base64');
          const { rows } = await client.query(
            `INSERT INTO flow_media_assets (user_id, kind, file_name, mime_type, size_bytes, data)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, m.kind, typeof m.fileName === 'string' ? m.fileName : 'archivo', m.mimeType, data.length, data]
          );
          if (typeof m.id === 'number') assetIdMap.set(m.id, rows[0].id);
          summary.flowMedia++;
        }
      }

      if ('flow' in payload) {
        if (payload.flow && typeof payload.flow === 'object' && Array.isArray(payload.flow.nodes)) {
          const flow = JSON.parse(JSON.stringify(payload.flow));
          remapAssetIds(flow, assetIdMap);
          await client.query(
            `INSERT INTO bot_flows (id, name, data, updated_at) VALUES ('main_flow', $1, $2, now())
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()`,
            [typeof flow.name === 'string' && flow.name ? flow.name : 'Flujo Principal de Atención', JSON.stringify(flow)]
          );
          summary.flow = 'replaced';
        } else if (payload.flow === null) {
          await client.query(`DELETE FROM bot_flows WHERE id = 'main_flow'`);
          summary.flow = 'removed';
        }
      }

      if (Array.isArray(payload.contacts) && payload.contacts.length > 0) {
        // bot_contacts está atado al número de WhatsApp conectado (owner_jid): sin sesión no hay a
        // qué número colgarle los contactos.
        const ownerJid = WhatsappService.getOwnerJid(userId) || '';
        if (!ownerJid) {
          summary.contactsSkipped = true;
        } else {
          await client.query(
            'UPDATE bot_contacts SET bot_enabled = false, is_blacklisted = false WHERE user_id = $1 AND owner_jid = $2',
            [userId, ownerJid]
          );
          for (const c of payload.contacts) {
            if (typeof c?.jid !== 'string' || !c.jid.includes('@')) continue;
            const blacklisted = c.isBlacklisted === true;
            await client.query(
              `INSERT INTO bot_contacts (user_id, owner_jid, jid, name, is_group, bot_enabled, is_blacklisted, lid)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (user_id, owner_jid, jid) DO UPDATE
                 SET bot_enabled = EXCLUDED.bot_enabled, is_blacklisted = EXCLUDED.is_blacklisted,
                     lid = COALESCE(EXCLUDED.lid, bot_contacts.lid)`,
              [
                userId,
                ownerJid,
                c.jid,
                typeof c.name === 'string' && c.name ? c.name : c.jid.split('@')[0],
                c.isGroup === true,
                // En Blacklist el bot siempre queda apagado (ver BotContactService.setBlacklisted).
                !blacklisted && c.botEnabled === true,
                blacklisted,
                typeof c.lid === 'string' && c.lid ? c.lid : null,
              ]
            );
            summary.contacts++;
          }
        }
      }

      await client.query('COMMIT');
      return summary;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
