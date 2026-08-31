import { db } from './src/config/db.js';

async function run() {
  const kbSchema = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_bases'`);
  console.log("knowledge_bases columns:", kbSchema.rows.map(r => r.column_name));

  const kbs = await db.query('SELECT * FROM knowledge_bases');
  console.log("KBs:", kbs.rows);

  const docs = await db.query('SELECT * FROM knowledge_documents');
  console.log("Docs:", docs.rows);

  process.exit(0);
}
run().catch(console.error);
