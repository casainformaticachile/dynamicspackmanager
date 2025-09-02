// La primera línea carga las variables de entorno del archivo .env
import 'dotenv/config'; 
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN SEGURA DE LA CONEXIÓN A POSTGRESQL ---
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('ERROR CRÍTICO: La variable de entorno DATABASE_URL no está definida.');
    process.exit(1); 
}

const pool = new pg.Pool({
    connectionString: connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Error al conectar con la base de datos:', err);
    } else {
        console.log('Conexión a la base de datos establecida con éxito a las:', res.rows[0].now);
    }
});

app.use(express.static(__dirname));
app.use(express.json());

// =================================================================
// === API EXTERNA Y ENDPOINTS DE DATOS (GET) ===
// =================================================================
const URL_API_ORDENES = process.env.API_ORDERS_URL || 'https://drbprod.sithfruits.com/api/vista_marketers_orders_activas3';

app.get('/api/orders', async (req, res) => {
  try {
    const response = await fetch(URL_API_ORDENES);
    if (!response.ok) {
      throw new Error(`La API externa respondió con error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error en /api/orders:', err);
    res.status(500).json({ success: false, error: 'No se pudieron obtener las órdenes desde la API externa.' });
  }
});

app.get('/api/logos', async (req, res) => {
    try {
        const result = await pool.query('SELECT marketer_name, logo_filename FROM marketer_logos');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error en GET /api/logos:', error);
        res.status(500).json({ success: false, error: 'No se pudo obtener la lista de logos.' });
    }
});

app.get('/api/outfeeds', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, description FROM outfeeds ORDER BY id');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error en GET /api/outfeeds:', error);
        res.status(500).json({ success: false, error: 'No se pudo obtener la lista de outfeeds.' });
    }
});

// =================================================================
// === NUEVOS ENDPOINTS PARA EL TABLERO DE PLANIFICACIÓN ===
// =================================================================

// Endpoint para obtener el estado completo del tablero al cargar la página.
app.get('/api/planning-board-state', async (req, res) => {
    try {
        const [queueRes, statusRes] = await Promise.all([
            pool.query('SELECT outfeed_id, tag, order_id, standard_id, sequence FROM outfeed_queue ORDER BY outfeed_id, sequence'),
            pool.query('SELECT outfeed_id, status FROM outfeed_status')
        ]);

        const queues = queueRes.rows.reduce((acc, row) => {
            if (!acc[row.outfeed_id]) acc[row.outfeed_id] = [];
            acc[row.outfeed_id].push({ tag: row.tag, order_id: row.order_id, standard_id: row.standard_id });
            return acc;
        }, {});

        const statuses = statusRes.rows.reduce((acc, row) => {
            acc[row.outfeed_id] = row.status;
            return acc;
        }, {});

        res.json({ success: true, queues, statuses });
    } catch (error) {
        console.error('Error en GET /api/planning-board-state:', error);
        res.status(500).json({ success: false, error: 'No se pudo obtener el estado del tablero.' });
    }
});

// Endpoint para planificar una línea (crear Tag y añadir a la cola).
app.post('/api/plan-order', async (req, res) => {
    const { orderId, standardId, outfeedIds, isHighPriority } = req.body;
    if (!orderId || !standardId || !outfeedIds || !outfeedIds.length) {
        return res.status(400).json({ success: false, message: 'Faltan datos para planificar la orden.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener el load_name de la orden.
        const loadRes = await client.query('SELECT load_name FROM loads WHERE order_id = $1', [orderId]);
        if (loadRes.rows.length === 0) {
            throw new Error(`La orden ${orderId} no tiene un Load asignado.`);
        }
        const loadName = loadRes.rows[0].load_name;

        // 2. Generar el siguiente tag correlativo para ese load.
        // Se busca si ya existe un tag para esta línea específica.
        let tagRes = await client.query('SELECT tag FROM outfeed_queue WHERE order_id = $1 AND standard_id = $2 LIMIT 1', [orderId, standardId]);
        let newTag;

        if (tagRes.rows.length > 0) {
            newTag = tagRes.rows[0].tag; // Usar tag existente si la línea ya está en otra cola.
        } else {
            const lastTagRes = await client.query(
                "SELECT tag FROM outfeed_queue WHERE tag LIKE $1 || '%' ORDER BY tag DESC LIMIT 1",
                [loadName]
            );
            let newTagNumber = 1;
            if (lastTagRes.rows.length > 0) {
                const lastNumberStr = lastTagRes.rows[0].tag.replace(loadName, '');
                const lastNumber = parseInt(lastNumberStr, 10);
                if (!isNaN(lastNumber)) {
                    newTagNumber = lastNumber + 1;
                }
            }
            newTag = `${loadName}${String(newTagNumber).padStart(3, '0')}`;
        }
        
        for (const outfeedId of outfeedIds) {
            if (isHighPriority) {
                // Mover todo lo existente hacia abajo
                await client.query('UPDATE outfeed_queue SET sequence = sequence + 1 WHERE outfeed_id = $1', [outfeedId]);
                // Insertar el nuevo en la primera posición
                await client.query('INSERT INTO outfeed_queue (outfeed_id, tag, order_id, standard_id, sequence) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (outfeed_id, order_id, standard_id) DO NOTHING', [outfeedId, newTag, orderId, standardId]);
            } else {
                // Añadir al final de la cola
                const sequenceRes = await client.query('SELECT COALESCE(MAX(sequence), 0) as max_seq FROM outfeed_queue WHERE outfeed_id = $1', [outfeedId]);
                const newSequence = sequenceRes.rows[0].max_seq + 1;
                await client.query('INSERT INTO outfeed_queue (outfeed_id, tag, order_id, standard_id, sequence) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (outfeed_id, order_id, standard_id) DO NOTHING', [outfeedId, newTag, orderId, standardId, newSequence]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, newTag, message: `Línea ${orderId}-${standardId} planificada con tag ${newTag}.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en POST /api/plan-order:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// Endpoint para "des-planificar" una orden (eliminar Tag de una o todas las colas).
app.post('/api/unplan-order', async (req, res) => {
    const { tag, outfeedId } = req.body; // outfeedId es opcional. Si no se provee, se elimina de todas.
    if (!tag) {
        return res.status(400).json({ success: false, message: 'Falta el tag a desplanificar.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (outfeedId) {
            await client.query('DELETE FROM outfeed_queue WHERE tag = $1 AND outfeed_id = $2', [tag, outfeedId]);
        } else {
            await client.query('DELETE FROM outfeed_queue WHERE tag = $1', [tag]);
        }
        // Re-secuenciar las colas afectadas
        const affectedOutfeedsRes = await client.query('SELECT DISTINCT outfeed_id FROM outfeed_queue WHERE outfeed_id IN (SELECT outfeed_id FROM outfeed_queue WHERE tag = $1)', [tag]);
        for (const row of affectedOutfeedsRes.rows) {
            const items = await client.query('SELECT id FROM outfeed_queue WHERE outfeed_id = $1 ORDER BY sequence', [row.outfeed_id]);
            for (let i = 0; i < items.rows.length; i++) {
                await client.query('UPDATE outfeed_queue SET sequence = $1 WHERE id = $2', [i + 1, items.rows[i].id]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, message: `Tag ${tag} eliminado de la planificación.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en POST /api/unplan-order:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});


// Endpoint para actualizar el orden de una cola (Drag & Drop).
// CORREGIDO: Lógica de transacción para drag & drop entre colas.
app.post('/api/update-queue-order', async (req, res) => {
    const { fromOutfeedId, toOutfeedId, movedTag, newOrderedTags } = req.body;
    if (!toOutfeedId || !movedTag || !Array.isArray(newOrderedTags)) {
        return res.status(400).json({ success: false, message: 'Petición inválida.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Si el tag se movió de una cola a otra, primero se elimina de la original.
        if (fromOutfeedId && fromOutfeedId !== toOutfeedId) {
            await client.query('DELETE FROM outfeed_queue WHERE tag = $1 AND outfeed_id = $2', [movedTag, fromOutfeedId]);
        }

        // Se reordena la cola de destino.
        for (let i = 0; i < newOrderedTags.length; i++) {
            const tag = newOrderedTags[i];
            const { order_id, standard_id } = tag; // El cliente debe enviar esta info
            
            // Usamos ON CONFLICT para insertar si es nuevo, o actualizar si ya existe (movimiento dentro de la misma cola)
            await client.query(
                `INSERT INTO outfeed_queue (outfeed_id, tag, order_id, standard_id, sequence) 
                 VALUES ($1, $2, $3, $4, $5) 
                 ON CONFLICT (outfeed_id, tag) 
                 DO UPDATE SET sequence = $5`,
                [toOutfeedId, tag.tag, tag.order_id, tag.standard_id, i + 1]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `Cola para outfeed ${toOutfeedId} actualizada.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en POST /api/update-queue-order:', error);
        res.status(500).json({ success: false, message: 'No se pudo actualizar el orden de la cola.' });
    } finally {
        client.release();
    }
});


// Endpoint para cambiar el estado de un Outfeed (RUNNING/PAUSED).
app.post('/api/outfeed-status', async (req, res) => {
    const { outfeedId, status } = req.body;
    if (!outfeedId || !['RUNNING', 'PAUSED'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Petición inválida.' });
    }
    try {
        await pool.query(
            'INSERT INTO outfeed_status (outfeed_id, status, last_updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (outfeed_id) DO UPDATE SET status = $2, last_updated_at = CURRENT_TIMESTAMP',
            [outfeedId, status]
        );
        res.json({ success: true, message: `Estado de Outfeed ${outfeedId} actualizado a ${status}.` });
    } catch (error) {
        console.error('Error en POST /api/outfeed-status:', error);
        res.status(500).json({ success: false, message: 'No se pudo actualizar el estado del outfeed.' });
    }
});


// =================================================================
// === ENDPOINTS DE VERIFICACIÓN DE CONTRASEÑAS (Lógica corregida) ===
// =================================================================
app.post('/api/verify-feature-password', async (req, res) => {
    const { feature, password } = req.body;
    if (!feature || !password) {
        return res.status(400).json({ success: false, message: 'Faltan "feature" o "password".' });
    }

    const validFeatures = ['outfeed', 'priority', 'load', 'schedule', 'all'];
    
    if (!validFeatures.includes(feature)) {
        return res.status(400).json({ success: false, message: 'Feature no válida.' });
    }

    // CORREGIDO: Todos los features de desbloqueo usan la misma clave unificada.
    const configKey = 'schedule_unlock_password';
    
    try {
        const query = "SELECT config_value FROM app_config WHERE config_key = $1";
        const result = await pool.query(query, [configKey]);
        if (result.rows.length > 0 && result.rows[0].config_value === password) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Contraseña no válida.' });
        }
    } catch (error) {
        console.error(`Error verificando la contraseña para [${feature}] -> [${configKey}]:`, error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});

app.post('/api/verify-price-password', async (req, res) => {
    const { password } = req.body;
    try {
        const query = "SELECT config_value FROM app_config WHERE config_key = 'price_password'";
        const result = await pool.query(query);
        if (result.rows.length > 0 && result.rows[0].config_value === password) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false });
        }
    } catch (error) {
        console.error('Error verificando la contraseña de precios:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});


// =================================================================
// === ENDPOINTS DE ESTADO (Loads, Priorities - Sin cambios) ===
// =================================================================
app.post('/api/loads', async (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) { return res.status(400).json({ error: 'El cuerpo de la petición debe contener un array de "updates".' }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { orderId, load } of updates) {
        if (load) {
            await client.query(`INSERT INTO loads (order_id, load_name) VALUES ($1, $2) ON CONFLICT (order_id) DO UPDATE SET load_name = $2, last_updated_at = CURRENT_TIMESTAMP;`, [orderId, load]);
        } else {
            await client.query('DELETE FROM loads WHERE order_id = $1', [orderId]);
        }
    }
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: `${updates.length} loads actualizados.` });
  } catch (error) { await client.query('ROLLBACK'); console.error('Error en POST /api/loads:', error); res.status(500).json({ error: 'No se pudo guardar el lote de loads.' });
  } finally { client.release(); }
});

app.post('/api/priorities', async (req, res) => {
    const newPriorities = req.body;
    if (typeof newPriorities !== 'object' || newPriorities === null) { return res.status(400).json({ error: 'El cuerpo de la petición debe ser un objeto.' }); }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE load_priorities');
        for (const [loadName, priorityOrder] of Object.entries(newPriorities)) { await client.query('INSERT INTO load_priorities (load_name, priority_order) VALUES ($1, $2)', [loadName, priorityOrder]); }
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Prioridades actualizadas.' });
    } catch (error) { await client.query('ROLLBACK'); console.error('Error en POST /api/priorities:', error); res.status(500).json({ error: 'No se pudieron guardar las prioridades.' });
    } finally { client.release(); }
});

// =================================================================
// === ENDPOINT DE RECONCILIACIÓN (LÓGICA ACTUALIZADA) ===
// =================================================================
const getPackingStatus = (order, state) => {
    if ((parseFloat(order.cantidad_despachada) || 0) > 0) return 'shipped';
    const req = parseFloat(order.cantidad_solicitada) || 0;
    if (req > 0) {
        const ass = parseFloat(order.cantidad_asignada) || 0;
        const cxp = parseFloat(order.cajas_por_pallet) || 1;
        if (ass / cxp >= req / cxp) return 'done';
    }

    if (state.isBeingPackedSet.has(`${order.id_marketer_order}-${order.codigo_producto}`)) {
        return 'being_packed';
    }
    if ((parseFloat(order.cantidad_asignada) || 0) > 0) return 'partially';
    return 'pending';
};

app.post('/api/reconcile', async (req, res) => {
    console.log(`Iniciando reconciliación...`);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. OBTENER DATOS DE LA API Y DE LA BD
        const apiOrdersResponse = await fetch(URL_API_ORDENES);
        if (!apiOrdersResponse.ok) throw new Error('La API de órdenes falló.');
        const apiData = await apiOrdersResponse.json();
        if (!apiData || !apiData[0] || !Array.isArray(apiData[0].data)) throw new Error('Formato de API de órdenes inesperado.');
        const allApiOrders = apiData[0].data;

        const [dbLoads, dbPriorities, dbQueue, dbOutfeedStatus] = await Promise.all([
            client.query('SELECT order_id, load_name FROM loads'),
            client.query('SELECT load_name, priority_order FROM load_priorities'),
            client.query('SELECT outfeed_id, tag, order_id, standard_id, sequence FROM outfeed_queue'),
            client.query('SELECT outfeed_id, status FROM outfeed_status')
        ]);
        
        // --- INICIO LÓGICA DE AVANCE DE COLA ---
        
        const isBeingPackedSet = new Set();
        dbQueue.rows.filter(r => r.sequence === 1).forEach(r => {
             // Una línea solo está "siendo empacada" si su outfeed está en RUNNING
            const outfeedStatus = dbOutfeedStatus.rows.find(s => s.outfeed_id === r.outfeed_id)?.status;
            if (outfeedStatus === 'RUNNING') {
                isBeingPackedSet.add(`${r.order_id}-${r.standard_id}`);
            }
        });

        const tempStateForStatus = { isBeingPackedSet };
        const ordersWithStatus = allApiOrders.map(order => ({ ...order, packing_status: getPackingStatus(order, tempStateForStatus) }));
        
        const doneTagsToDelete = new Set();
        const outfeedsToPromote = new Map(); 

        for (const item of dbQueue.rows) {
            if (item.sequence === 1) {
                const order = ordersWithStatus.find(o => o.id_marketer_order == item.order_id && o.codigo_producto == item.standard_id);
                if (order && (order.packing_status === 'done' || order.packing_status === 'shipped')) {
                    doneTagsToDelete.add(item.tag);
                    const outfeedStatusRow = dbOutfeedStatus.rows.find(s => s.outfeed_id === item.outfeed_id);
                    const status = outfeedStatusRow ? outfeedStatusRow.status : 'PAUSED';
                    outfeedsToPromote.set(item.outfeed_id, status);
                }
            }
        }
        
        if (doneTagsToDelete.size > 0) {
            console.log("Tags a eliminar por estar 'Done':", Array.from(doneTagsToDelete));
            await client.query('DELETE FROM outfeed_queue WHERE tag = ANY($1::text[])', [Array.from(doneTagsToDelete)]);
            
            for (const [outfeedId, status] of outfeedsToPromote.entries()) {
                const items = await client.query('SELECT id FROM outfeed_queue WHERE outfeed_id = $1 ORDER BY sequence', [outfeedId]);
                for (let i = 0; i < items.rows.length; i++) {
                    await client.query('UPDATE outfeed_queue SET sequence = $1 WHERE id = $2', [i + 1, items.rows[i].id]);
                }
                console.log(`Outfeed ${outfeedId} (estado: ${status}) ha sido limpiado y re-secuenciado.`);
            }
        }
        
        // --- FIN LÓGICA DE AVANCE DE COLA ---

        // 2. AGRUPAR POR LOAD Y DETERMINAR QUÉ LIBERAR
        const loadsGrouped = {};
        const stateForReconcile = { loads: dbLoads.rows.reduce((acc, row) => { acc[row.order_id] = row.load_name; return acc; }, {}) };
        for (const order of ordersWithStatus) {
            const loadName = stateForReconcile.loads[order.id_marketer_order];
            if (loadName) {
                if (!loadsGrouped[loadName]) loadsGrouped[loadName] = [];
                loadsGrouped[loadName].push(order);
            }
        }

        const loadsToReleasePriority = new Set();
        const loadsToReleaseLetter = new Set();
        for (const loadName in loadsGrouped) {
            const ordersInLoad = loadsGrouped[loadName];
            const isLoadFullyDone = ordersInLoad.every(o => o.packing_status === 'done' || o.packing_status === 'shipped');
            const isLoadShippedOrClosed = ordersInLoad.some(o => o.packing_status === 'shipped' || o.estado_marketer_order === 'cerrada');

            if (isLoadShippedOrClosed) {
                loadsToReleaseLetter.add(loadName);
            } else if (isLoadFullyDone) {
                loadsToReleasePriority.add(loadName);
            }
        }

        // 3. CALCULAR EL ESTADO FINAL DE PRIORIDADES
        const currentPriorities = dbPriorities.rows.reduce((acc, row) => { acc[row.load_name] = row.priority_order; return acc; }, {});
        const finalPriorities = Object.entries(currentPriorities)
            .filter(([loadName]) => !loadsToReleaseLetter.has(loadName) && !loadsToReleasePriority.has(loadName))
            .sort(([, prioA], [, prioB]) => prioA - prioB)
            .reduce((acc, [loadName], index) => {
                acc[loadName] = index + 1;
                return acc;
            }, {});
        
        // 4. EJECUTAR ESCRITURAS EN LA BASE DE DATOS
        await client.query('TRUNCATE TABLE load_priorities');
        if (Object.keys(finalPriorities).length > 0) {
            const priorityInserts = Object.entries(finalPriorities).map(([loadName, priorityOrder]) => {
                return client.query('INSERT INTO load_priorities (load_name, priority_order) VALUES ($1, $2)', [loadName, priorityOrder]);
            });
            await Promise.all(priorityInserts);
        }
        
        if (loadsToReleaseLetter.size > 0) {
            await client.query('DELETE FROM loads WHERE load_name = ANY($1::text[])', [Array.from(loadsToReleaseLetter)]);
        }
        
        // 5. CONSTRUIR LA RESPUESTA FINAL RE-LEYENDO EL ESTADO ACTUALIZADO
        const finalLoadsResult = await client.query('SELECT order_id, load_name FROM loads');
        const finalQueueResult = await client.query('SELECT outfeed_id, tag, order_id, standard_id, sequence FROM outfeed_queue ORDER BY outfeed_id, sequence');
        const finalStatusResult = await client.query('SELECT outfeed_id, status FROM outfeed_status');

        const finalState = {
            loads: finalLoadsResult.rows.reduce((acc, row) => { acc[row.order_id] = row.load_name; return acc; }, {}),
            priorities: finalPriorities,
            queues: finalQueueResult.rows.reduce((acc, row) => {
                const key = row.outfeed_id;
                if (!acc[key]) acc[key] = [];
                acc[key].push({ tag: row.tag, order_id: row.order_id, standard_id: row.standard_id });
                return acc;
            }, {}),
            statuses: finalStatusResult.rows.reduce((acc, row) => { acc[row.outfeed_id] = row.status; return acc; }, {})
        };
        
        await client.query('COMMIT');
        
        console.log("Reconciliación completada.");
        res.status(200).json({ success: true, state: finalState });

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Error durante la reconciliación:', error);
        res.status(500).json({ success: false, error: 'No se pudo completar la reconciliación.' });
    } finally {
        if (client) client.release();
    }
});


// Servir el archivo principal en la ruta raíz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint obsoleto, ahora manejado por la nueva lógica.
app.post('/api/outfeeds/assign', (req, res) => {
    console.warn("ADVERTENCIA: Se ha llamado al endpoint obsoleto /api/outfeeds/assign.");
    res.status(200).json({ success: true, message: "Endpoint obsoleto. Usar /api/plan-order." });
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}`);
});