import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const db = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'tactica_flow',
});

db.on('connect', () => {
  console.log('📦 Conectado exitosamente a PostgreSQL');
});

db.on('error', (err) => {
  console.error('❌ Error insospechado en cliente de PostgreSQL:', err);
});
