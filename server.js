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
    res.status(500).json({ error: 'No se pudieron obtener las órdenes desde la API externa.' });
  }
});

// ### NUEVO ENDPOINT PARA LOGOS ###
app.get('/api/logos', async (req, res) => {
    console.log("Petición recibida en GET /api/logos");
    try {
        const result = await pool.query('SELECT marketer_name, logo_filename FROM marketer_logos');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error en GET /api/logos:', error);
        res.status(500).json({ success: false, error: 'No se pudo obtener la lista de logos.' });
    }
});
// ### FIN DEL NUEVO ENDPOINT ###

app.get('/api/state', async (req, res) => {
    console.log("Petición recibida en GET /api/state");
    const client = await pool.connect();
    try {
        const loadsPromise = client.query('SELECT order_id, load_name FROM loads');
        const linesPromise = client.query('SELECT order_id, standard_id, line_name FROM line_assignments');
        const prioritiesPromise = client.query('SELECT load_name, priority_order FROM load_priorities');
        
        const [loadsResult, linesResult, prioritiesResult] = await Promise.all([loadsPromise, linesPromise, prioritiesPromise]);

        const loads = loadsResult.rows.reduce((acc, row) => { acc[row.order_id] = row.load_name; return acc; }, {});
        const lines = linesResult.rows.reduce((acc, row) => { const key = `${row.order_id}-${row.standard_id}`; if (!acc[key]) acc[key] = []; acc[key].push(row.line_name); return acc; }, {});
        const priorities = prioritiesResult.rows.reduce((acc, row) => { acc[row.load_name] = row.priority_order; return acc; }, {});

        res.json({ success: true, loads, lines, priorities });

    } catch (error) {
        console.error('Error en GET /api/state:', error);
        res.status(500).json({ success: false, error: 'No se pudo obtener el estado completo de la aplicación.' });
    } finally {
        client.release();
    }
});

// =================================================================
// === ENDPOINTS DE VERIFICACIÓN DE CONTRASEÑAS (SIN CAMBIOS) ===
// =================================================================
app.post('/api/verify-feature-password', async (req, res) => {
    const { feature, password } = req.body;
    if (!feature || !password) {
        return res.status(400).json({ success: false, message: 'Faltan "feature" o "password".' });
    }
    const configKey = `${feature}_unlock_password`;
    try {
        const query = "SELECT config_value FROM app_config WHERE config_key = $1";
        const result = await pool.query(query, [configKey]);
        if (result.rows.length > 0 && result.rows[0].config_value === password) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Contraseña no válida.' });
        }
    } catch (error) {
        console.error(`Error verificando la contraseña para [${feature}]:`, error);
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
// === ENDPOINTS DE ESTADO (POST/UPDATE) (SIN CAMBIOS) ===
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
app.post('/api/lines', async (req, res) => {
    const { assignmentKey, lines } = req.body;
    if (!assignmentKey) return res.status(400).json({ error: 'Falta "assignmentKey" en la petición.' });
    const [orderId, standardId] = assignmentKey.split('-');
    if (!orderId || !standardId) return res.status(400).json({ error: 'El formato de "assignmentKey" es inválido.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM line_assignments WHERE order_id = $1 AND standard_id = $2', [orderId, standardId]);
        if (lines && Array.isArray(lines) && lines.length > 0) {
            for (const lineName of lines) { await client.query('INSERT INTO line_assignments (order_id, standard_id, line_name) VALUES ($1, $2, $3)', [orderId, standardId, lineName]); }
        }
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Asignación de líneas actualizada.' });
    } catch (error) { await client.query('ROLLBACK'); console.error('Error en POST /api/lines:', error); res.status(500).json({ error: 'No se pudo guardar la asignación de líneas.' });
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
// === ENDPOINT DE RECONCILIACIÓN (SIN CAMBIOS) ===
// =================================================================
const isOsDone = (order) => {
    const req = (parseFloat(order.cantidad_solicitada) || 0);
    if (req === 0) return false;
    const ass = (parseFloat(order.cantidad_asignada) || 0);
    const ship = (parseFloat(order.cantidad_despachada) || 0);
    const cxp = (parseFloat(order.cajas_por_pallet) || 1);
    return (ass / cxp >= req / cxp) || ((ship / cxp).toFixed(2) === (req / cxp).toFixed(2));
};

app.post('/api/reconcile', async (req, res) => {
    console.log(`Iniciando reconciliación...`);
    const client = await pool.connect();

    try {
        // 1. Obtener datos frescos de la API externa
        const apiOrdersResponse = await fetch(URL_API_ORDENES);
        if (!apiOrdersResponse.ok) throw new Error('La API de órdenes falló al ser contactada.');
        const apiData = await apiOrdersResponse.json();
        if (!apiData || !apiData[0] || !Array.isArray(apiData[0].data)) throw new Error('La respuesta de la API de órdenes no tiene el formato esperado.');
        const allApiOrders = apiData[0].data;
        
        await client.query('BEGIN');

        // 2. Lógica de Negocio para LOADS y PRIORITIES
        const dbLoadsResult = await client.query('SELECT order_id, load_name FROM loads');
        const allApiOrdersMap = new Map(allApiOrders.map(o => [o.id_marketer_order, o]));
        const loadsGrouped = {};
        for (const dbLoad of dbLoadsResult.rows) {
            const order = allApiOrdersMap.get(dbLoad.order_id);
            if (order) {
                if (!loadsGrouped[dbLoad.load_name]) loadsGrouped[dbLoad.load_name] = [];
                loadsGrouped[dbLoad.load_name].push(order);
            }
        }
        
        const loadsToReleasePriority = new Set();
        const loadsToReleaseLetter = new Set();
        for (const loadName in loadsGrouped) {
            const ordersInLoad = loadsGrouped[loadName];
            const isLoadFullyDone = ordersInLoad.every(isOsDone);
            const isLoadShipped = ordersInLoad.some(o => (parseFloat(o.cantidad_despachada) || 0) > 0);
            const isLoadClosed = ordersInLoad.every(o => o.estado_marketer_order === 'cerrada');

            if (isLoadShipped || isLoadClosed) loadsToReleaseLetter.add(loadName);
            else if (isLoadFullyDone) loadsToReleasePriority.add(loadName);
        }

        if (loadsToReleaseLetter.size > 0) await client.query('DELETE FROM loads WHERE load_name = ANY($1::text[])', [Array.from(loadsToReleaseLetter)]);
        if (loadsToReleasePriority.size > 0) await client.query('DELETE FROM load_priorities WHERE load_name = ANY($1::text[])', [Array.from(loadsToReleasePriority)]);
        
        // 3. Lógica de Negocio para LINES
        const doneOsKeys = allApiOrders.filter(isOsDone).map(order => `(${order.id_marketer_order}, '${order.codigo_producto}')`);
        if (doneOsKeys.length > 0) {
            await client.query(`DELETE FROM line_assignments WHERE (order_id, standard_id) IN (${doneOsKeys.join(',')})`);
        }

        // 4. Limpieza de datos huérfanos
        const allApiOsKeysStr = allApiOrders.map(o => `(${o.id_marketer_order}, '${o.codigo_producto}')`).join(',');
        if (allApiOsKeysStr) await client.query(`DELETE FROM line_assignments WHERE (order_id, standard_id) NOT IN (${allApiOsKeysStr})`);
        else await client.query('TRUNCATE TABLE line_assignments');

        const allApiOrderIds = allApiOrders.map(o => o.id_marketer_order);
        if (allApiOrderIds.length > 0) await client.query('DELETE FROM loads WHERE order_id != ALL($1::bigint[])', [allApiOrderIds]);
        else await client.query('TRUNCATE TABLE loads');

        // 5. Sincronizar y re-secuenciar prioridades
        const usedLoadsResult = await client.query('SELECT DISTINCT load_name FROM loads');
        const usedLoads = usedLoadsResult.rows.map(r => r.load_name);
        if (usedLoads.length > 0) await client.query('DELETE FROM load_priorities WHERE load_name != ALL($1::text[])', [usedLoads]);
        else await client.query('TRUNCATE TABLE load_priorities');
        
        const remainingPrioritiesResult = await client.query('SELECT load_name, priority_order FROM load_priorities ORDER BY priority_order ASC');
        for (let i = 0; i < remainingPrioritiesResult.rows.length; i++) {
            const row = remainingPrioritiesResult.rows[i];
            if (row.priority_order !== i + 1) await client.query('UPDATE load_priorities SET priority_order = $1 WHERE load_name = $2', [i + 1, row.load_name]);
        }
        
        // 6. OBTENER Y DEVOLVER EL ESTADO FINAL
        const loadsPromise = client.query('SELECT order_id, load_name FROM loads');
        const linesPromise = client.query('SELECT order_id, standard_id, line_name FROM line_assignments');
        const prioritiesPromise = client.query('SELECT load_name, priority_order FROM load_priorities');
        
        const [finalLoads, finalLines, finalPriorities] = await Promise.all([loadsPromise, linesPromise, prioritiesPromise]);

        const loads = finalLoads.rows.reduce((acc, row) => { acc[row.order_id] = row.load_name; return acc; }, {});
        const lines = finalLines.rows.reduce((acc, row) => { const key = `${row.order_id}-${row.standard_id}`; if (!acc[key]) acc[key] = []; acc[key].push(row.line_name); return acc; }, {});
        const priorities = finalPriorities.rows.reduce((acc, row) => { acc[row.load_name] = row.priority_order; return acc; }, {});

        await client.query('COMMIT');
        
        console.log("Reconciliación completada. Devolviendo estado final.");
        res.status(200).json({ success: true, state: { loads, lines, priorities } });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error durante la reconciliación:', error);
        res.status(500).json({ success: false, error: 'No se pudo completar la reconciliación.' });
    } finally {
        client.release();
    }
});


// Servir el archivo principal en la ruta raíz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}`);
});