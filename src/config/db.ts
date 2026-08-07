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
