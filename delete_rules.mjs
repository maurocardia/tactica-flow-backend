import { Client } from 'pg';
const client = new Client({ host: 'sakura.proxy.rlwy.net', port: 19251, user: 'postgres', password: 'hsygUVNhuZYKjfAPjFXlORhrMDRFheCT', database: 'railway' });
await client.connect();
const res = await client.query("DELETE FROM keyword_rules WHERE id LIKE 'node_%' OR id LIKE 'opt_%'");
console.log('Deleted rules:', res.rowCount);
await client.end();
