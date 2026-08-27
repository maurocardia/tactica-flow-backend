import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys';
import { db } from '../config/db.js';

/**
 * Proveedor de Auth State para Baileys respaldado 100% en PostgreSQL.
 * Almacena las credenciales principales (creds) y todas las llaves criptográficas de la sesión
 * en la tabla `whatsapp_sessions`, garantizando que tras cada reinicio, nuevo despliegue o
 * cambio de contenedor en Railway la sesión se mantenga viva y activa de forma permanente
 * sin requerir volver a escanear el código QR.
 */
export async function usePostgresAuthState(userId: number): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearCreds: () => Promise<void>;
}> {
  // 1. Cargar credenciales principales (creds)
  let creds: AuthenticationCreds;
  try {
    const credsRes = await db.query(
      'SELECT data FROM whatsapp_sessions WHERE user_id = $1 AND key_id = $2',
      [userId, 'creds']
    );

    if (credsRes.rows.length > 0 && credsRes.rows[0].data) {
      creds = JSON.parse(credsRes.rows[0].data, BufferJSON.reviver);
    } else {
      creds = initAuthCreds();
    }
  } catch (err) {
    console.warn(`⚠️ [Postgres Auth] Error cargando creds para usuario ${userId}, inicializando nuevas:`, err);
    creds = initAuthCreds();
  }

  const saveCreds = async (): Promise<void> => {
    try {
      const serialized = JSON.stringify(creds, BufferJSON.replacer);
      await db.query(
        `INSERT INTO whatsapp_sessions (user_id, key_id, data, updated_at)
         VALUES ($1, 'creds', $2, now())
         ON CONFLICT (user_id, key_id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [userId, serialized]
      );
    } catch (err) {
      console.error(`❌ [Postgres Auth] Error guardando creds de usuario ${userId}:`, err);
    }
  };

  const clearCreds = async (): Promise<void> => {
    try {
      await db.query('DELETE FROM whatsapp_sessions WHERE user_id = $1', [userId]);
      console.log(`🧹 [Postgres Auth] Sesión eliminada de PostgreSQL para usuario ${userId}`);
    } catch (err) {
      console.error(`❌ [Postgres Auth] Error eliminando sesión de usuario ${userId}:`, err);
    }
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result: { [key: string]: SignalDataTypeMap[typeof type] } = {};
        if (ids.length === 0) return result;

        try {
          const dbKeyIds = ids.map((id) => `${type}-${id}`);
          const { rows } = await db.query(
            'SELECT key_id, data FROM whatsapp_sessions WHERE user_id = $1 AND key_id = ANY($2)',
            [userId, dbKeyIds]
          );

          for (const row of rows) {
            try {
              const prefix = `${type}-`;
              const rawId = row.key_id.startsWith(prefix) ? row.key_id.slice(prefix.length) : row.key_id;
              let value = JSON.parse(row.data, BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              result[rawId] = value;
            } catch (parseErr) {
              console.warn(`⚠️ [Postgres Auth] Error parseando key ${row.key_id}:`, parseErr);
            }
          }
        } catch (dbErr) {
          console.error(`❌ [Postgres Auth] Error leyendo keys (${type}) para usuario ${userId}:`, dbErr);
        }

        return result;
      },
      set: async (data) => {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          for (const category of Object.keys(data)) {
            const categoryObj = (data as any)[category];
            if (!categoryObj) continue;

            for (const id of Object.keys(categoryObj)) {
              const value = categoryObj[id];
              const dbKeyId = `${category}-${id}`;

              if (value == null) {
                await client.query(
                  'DELETE FROM whatsapp_sessions WHERE user_id = $1 AND key_id = $2',
                  [userId, dbKeyId]
                );
              } else {
                const serialized = JSON.stringify(value, BufferJSON.replacer);
                await client.query(
                  `INSERT INTO whatsapp_sessions (user_id, key_id, data, updated_at)
                   VALUES ($1, $2, $3, now())
                   ON CONFLICT (user_id, key_id)
                   DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
                  [userId, dbKeyId, serialized]
                );
              }
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`❌ [Postgres Auth] Error persistiendo keys en PostgreSQL:`, err);
        } finally {
          client.release();
        }
      }
    }
  };

  return { state, saveCreds, clearCreds };
}
