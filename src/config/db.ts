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
