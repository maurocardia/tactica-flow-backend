import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// PG_SSL=true fuerza SSL (necesario en algunos proveedores gestionados como Railway/Heroku).
// rejectUnauthorized:false porque estos proveedores suelen usar certificados que Node no
// valida por defecto contra una CA conocida.
const sslConfig = process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

export const db = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'tactica_flow',
  ssl: sslConfig,
  connectionTimeoutMillis: 10000,
});

db.on('connect', () => {
  console.log('📦 Conectado exitosamente a PostgreSQL (TypeScript)');
});

db.on('error', (err: Error) => {
  console.error('❌ Error insospechado en cliente de PostgreSQL:', err);
});

// Esquema simplificado y NO normalizado (a diferencia del esquema multi-tenant descrito en
// DOCUMENTACION_TECNICA.md): estas tablas guardan directamente lo que hoy usan los servicios
// en memoria (conversation.service.ts y keywordRule.service.ts), sin depender de tenants,
// whatsapp_sessions ni whatsapp_contacts, que todavía no existen en el código. Se puede migrar
// al esquema completo más adelante cuando se agregue multi-tenant/auth real.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS keyword_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keywords TEXT[] NOT NULL,
    reply_text TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'STATIC_REPLY',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS bot_flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    last_msg TEXT NOT NULL DEFAULT '',
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    unread INT NOT NULL DEFAULT 0,
    tag TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bot', 'resolved'))
  );

  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_jid TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_conversations_owner_jid ON conversations(user_id, owner_jid);

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('customer', 'agent', 'bot')),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

  -- Base de Conocimiento (Issue #7): documentos (PDF/Word/MD/TXT) que alimentan el contexto
  -- del bot de IA. Global para toda la empresa por ahora (sin user_id/tenant): no hay auth
  -- todavía (Issue #6). Cuando exista, se puede sumar una FK a users sin romper lo existente.
  CREATE TABLE IF NOT EXISTS knowledge_bases (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id SERIAL PRIMARY KEY,
    knowledge_base_id INT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    char_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb_id ON knowledge_documents(knowledge_base_id);

  -- Autenticación Google OAuth (Issue #6): usuarios que loguean con Google desde la extensión
  -- de Chrome. El backend verifica el idToken y emite su propio JWT (ver auth.service.ts).
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    whatsapp_channel TEXT NOT NULL DEFAULT 'none',
    ai_provider TEXT NOT NULL DEFAULT 'google',
    ai_model TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
    bot_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Conexión nativa a WhatsApp vía Baileys (Issue #9): cada usuario tiene su propia sesión, y
  -- los chats que llegan por su número deben quedar atados a él. Nullable porque las
  -- conversaciones creadas antes de esta migración (demo/web sin WhatsApp conectado) no tienen
  -- dueño; ADD COLUMN IF NOT EXISTS porque la tabla "conversations" ya existe en producción.
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);

  -- Nombre del grupo de WhatsApp cuando esta conversación es la de UN participante puntual
  -- dentro de un grupo (ver WhatsappService.handleIncomingMessage: cada participante tiene su
  -- propia conversación con su propio historial, no una sola para todo el grupo). NULL en chats
  -- individuales. Permite que el panel identifique y liste a todos los participantes de un
  -- mismo grupo real — ver GET /api/conversations y AiSummaryModal.
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS group_name TEXT;

  -- ADD COLUMN IF NOT EXISTS porque la tabla "users" ya existe en producción desde antes de este
  -- interruptor: apaga/prende el auto-responder de WhatsApp (Baileys) para este usuario.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT true;

  -- Switch "Responder con IA" del panel: con el bot habilitado, si ningún keyword_rule matchea,
  -- este flag decide si se cae al agente de IA (true, comportamiento histórico) o si en cambio
  -- no se manda ninguna respuesta automática y queda solo el chatbot manual (false). Default true
  -- para no cambiar el comportamiento de nadie que todavía no tocó este switch nuevo.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_fallback_enabled BOOLEAN NOT NULL DEFAULT true;

  -- Instrucciones de comportamiento personalizadas para la IA (panel "Comportamiento de IA"):
  -- texto libre que el usuario define y que se inyecta en el system prompt, además de las reglas
  -- fijas y del contenido de la Base de Conocimiento — ver AIService.processMessage. Vacío por
  -- default: no cambia el comportamiento de nadie que no lo configure.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_custom_instructions TEXT NOT NULL DEFAULT '';

  -- Mensajes Programados y Tareas Automatizadas (Feature #5)
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    owner_jid TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    message_text TEXT NOT NULL,
    execute_at TIMESTAMPTZ NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'once',
    stop_on_reply BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_execute ON scheduled_jobs(status, execute_at);
  
  -- Agregar la columna si la tabla ya existía
  ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS owner_jid TEXT NOT NULL DEFAULT '';

  -- Switch "Responder también en grupos" del panel: por default el bot solo autoresponde en
  -- chats individuales (ver WhatsappService.handleIncomingMessage, que hoy ignora todo mensaje
  -- de un @g.us). Default false para no cambiar el comportamiento de nadie — activarlo hace que
  -- el bot también entre a responder en los grupos de WhatsApp del usuario.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_groups_enabled BOOLEAN NOT NULL DEFAULT false;

  -- Switch "Activar el bot para contactos nuevos": por default un contacto que escribe por
  -- primera vez queda registrado en bot_contacts con el switch APAGADO (hay que prenderlo a mano
  -- desde el panel) — ver BotContactService.upsert/WhatsappService.handleIncomingMessage.
  -- Activando esto, esos contactos nuevos arrancan con el bot ya PRENDIDO, para no tener que ir a
  -- habilitarlos uno por uno cuando escribe gente que todavía no estaba en la lista.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_enabled_for_new_contacts BOOLEAN NOT NULL DEFAULT false;

  -- "Responder a todos" vs "Responder a contactos seleccionados": con esto en true, el bot le
  -- responde a CUALQUIER contacto sin importar su switch en bot_contacts (se salta ese chequeo
  -- por completo) — ver WhatsappService.handleIncomingMessage. Default false para no cambiarle el
  -- comportamiento a nadie: sigue respetando el switch por contacto como hasta ahora.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_reply_to_all BOOLEAN NOT NULL DEFAULT false;

  -- Qué bases de conocimiento estaban activas cuando se generó cada respuesta del bot (vacío
  -- para mensajes del cliente, respuestas por regla fija, o respuestas de IA sin ninguna base
  -- activa en ese momento). Sirve para filtrar el historial que se le manda a la IA como
  -- contexto: si una base se desactiva, sus respuestas viejas dejan de "pesar" en charlas
  -- futuras con el mismo contacto, sin necesidad de borrar el historial — ver
  -- ConversationService.toAiHistory().
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_kb_ids INTEGER[] NOT NULL DEFAULT '{}';

  -- Persistencia de Sesión de Baileys en PostgreSQL (inmune a reinicios/despliegues de Railway)
  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    user_id INT NOT NULL,
    key_id VARCHAR(255) NOT NULL,
    data TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, key_id)
  );

  CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id ON whatsapp_sessions(user_id);

  -- Switch de bot POR CONTACTO — versión vieja (2026-08-28), reemplazada por la tabla
  -- "bot_contacts" de abajo. Se deja la columna sin usar (no se borra ni se migra) para no tocar
  -- filas existentes de "conversations"; el panel y el gating del bot ya no la consultan.
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT false;

  -- Lista PROPIA de "contactos administrables" para el switch de bot por contacto (panel: "Bot
  -- habilitado por contacto") — separada a propósito de "conversations"/"messages". Motivo: la
  -- tabla conversations mezclaba historial real de charla con la identidad del contacto, y un
  -- solo participante real terminaba repartido en varias filas (WhatsApp le va rotando un
  -- identificador @lid temporal — ver comentario de participantPn/senderPn en
  -- whatsapp.service.ts). Esta tabla es un espejo liviano, de solo lectura desde el punto de
  -- vista de WhatsApp: se actualiza (upsert) con el nombre/actividad real cada vez que llega un
  -- mensaje o Baileys sincroniza un contacto, pero nunca borra ni modifica mensajes. Un grupo de
  -- WhatsApp es UNA sola fila acá (jid = el JID del grupo, is_group = true), no una por
  -- participante — la lógica de contexto por participante para la IA sigue viviendo en
  -- "conversations", sin cambios.
  CREATE TABLE IF NOT EXISTS bot_contacts (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_jid TEXT NOT NULL DEFAULT '',
    jid TEXT NOT NULL,
    name TEXT NOT NULL,
    is_group BOOLEAN NOT NULL DEFAULT false,
    bot_enabled BOOLEAN NOT NULL DEFAULT false,
    last_activity TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, owner_jid, jid)
  );

  -- Agregar la columna si la tabla ya existía antes de crear índices
  ALTER TABLE bot_contacts ADD COLUMN IF NOT EXISTS owner_jid TEXT NOT NULL DEFAULT '';
  ALTER TABLE bot_contacts DROP CONSTRAINT IF EXISTS bot_contacts_user_id_jid_key CASCADE;
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_contacts_user_id_owner_jid_jid_key') THEN
      ALTER TABLE bot_contacts ADD CONSTRAINT bot_contacts_user_id_owner_jid_jid_key UNIQUE (user_id, owner_jid, jid);
    END IF;
  END $$;

  CREATE INDEX IF NOT EXISTS idx_bot_contacts_user_id ON bot_contacts(user_id, owner_jid, last_activity DESC);
`;

/**
 * Crea las tablas si no existen. Se llama una vez al arrancar el servidor (ver server.ts),
 * seguido de las siembras de datos de demo propias de cada servicio (KeywordRuleService.seedIfEmpty()
 * y ConversationService.seedIfEmpty()) para no perder la experiencia de demo que ya existía en
 * memoria. Si falla (ej: credenciales incorrectas o red inaccesible), lo logueamos pero no
 * tiramos abajo el proceso: otros endpoints que no dependen de la DB (ai/chat, tactica/*) deben
 * seguir funcionando, y las rutas que sí dependen de la DB devolverán 500 con el error real.
 */
export async function initDatabase(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log('🗄️  Esquema de PostgreSQL verificado/creado correctamente.');
  } finally {
    client.release();
  }
}
