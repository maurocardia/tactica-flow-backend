import { db } from './src/config/db.js';
async function run() {
  const users = await db.query('SELECT id, email, bot_enabled, bot_reply_to_all, ai_fallback_enabled FROM users WHERE id = 2');
  console.log(users.rows);
  process.exit(0);
}
run().catch(console.error);
