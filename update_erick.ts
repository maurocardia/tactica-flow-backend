import { db } from './src/config/db.js';
async function run() {
  await db.query("UPDATE bot_contacts SET bot_enabled = true WHERE jid = '114156103540945@lid'");
  console.log("Updated Erick's lid to true");
  process.exit(0);
}
run().catch(console.error);
