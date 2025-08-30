import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// CAMBIO PARA RENDER: el puerto viene de la variable de entorno
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// =================================================================
// === API EXTERNA DE ÓRDENES ===
// =================================================================
const URL_API_ORDENES = 'https://drbprod.sithfruits.com/api/vista_marketers_orders_activas3';

app.get('/api/orders', async (req, res) => {
  try {
    console.log(`Pidiendo órdenes a la API externa: ${URL_API_ORDENES}`);
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

// --- Rutas para archivos locales (Loads, Lines, Priorities) ---
const LOADS_FILE_PATH = path.join(__dirname, 'loads.json');
const LINES_FILE_PATH = path.join(__dirname, 'lines.json');
const PRIORITIES_FILE_PATH = path.join(__dirname, 'priorities.json'); // NUEVO ARCHIVO

// Función auxiliar para leer archivos JSON de forma segura
async function readJsonFile(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        console.error(`Error leyendo el archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Rutas para LOADS ---
app.get('/api/loads', async (req, res) => {
  try {
    const data = await readJsonFile(LOADS_FILE_PATH, {});
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'No se pudieron leer los loads.' });
  }
});

app.post('/api/loads', async (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'El cuerpo de la petición debe contener un array de "updates".' });
  }
  try {
    const loads = await readJsonFile(LOADS_FILE_PATH, {});
    updates.forEach(({ orderId, load }) => {
      if (orderId) {
        if (load) {
          loads[orderId] = load;
        } else {
          delete loads[orderId];
        }
      }
    });
    await fs.writeFile(LOADS_FILE_PATH, JSON.stringify(loads, null, 2));
    res.status(200).json({ success: true, message: `${updates.length} loads actualizados.` });
  } catch (error) {
    console.error('Error en POST /api/loads:', error);
    res.status(500).json({ error: 'No se pudo guardar el lote de loads.' });
  }
});

// --- Rutas para LINES ---
app.get('/api/lines', async (req, res) => {
    try {
        const data = await readJsonFile(LINES_FILE_PATH, {});
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'No se pudieron leer las asignaciones de línea.' });
    }
});

app.post('/api/lines', async (req, res) => {
    const { assignmentKey, line } = req.body;
    if (!assignmentKey) {
        return res.status(400).json({ error: 'Falta "assignmentKey" en la petición.' });
    }
    try {
        const lines = await readJsonFile(LINES_FILE_PATH, {});
        if (line) {
            lines[assignmentKey] = line;
        } else {
            delete lines[assignmentKey];
        }
        await fs.writeFile(LINES_FILE_PATH, JSON.stringify(lines, null, 2));
        res.status(200).json({ success: true, message: 'Asignación de línea actualizada.' });
    } catch (error) {
        console.error('Error en POST /api/lines:', error);
        res.status(500).json({ error: 'No se pudo guardar la asignación de línea.' });
    }
});

// --- NUEVAS RUTAS PARA PRIORITIES ---
app.get('/api/priorities', async (req, res) => {
    try {
        const data = await readJsonFile(PRIORITIES_FILE_PATH, {});
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'No se pudieron leer las prioridades.' });
    }
});

app.post('/api/priorities', async (req, res) => {
    const newPriorities = req.body;
    if (typeof newPriorities !== 'object' || newPriorities === null) {
        return res.status(400).json({ error: 'El cuerpo de la petición debe ser un objeto.' });
    }
    try {
        await fs.writeFile(PRIORITIES_FILE_PATH, JSON.stringify(newPriorities, null, 2));
        res.status(200).json({ success: true, message: 'Prioridades actualizadas.' });
    } catch (error) {
        console.error('Error en POST /api/priorities:', error);
        res.status(500).json({ error: 'No se pudieron guardar las prioridades.' });
    }
});

// --- RUTA DE SINCRONIZACIÓN GLOBAL ---
app.post('/api/sync_all', async (req, res) => {
    const { lines, priorities } = req.body;
    try {
        const promises = [];
        if (lines) {
            promises.push(fs.writeFile(LINES_FILE_PATH, JSON.stringify(lines, null, 2)));
        }
        if (priorities) {
            promises.push(fs.writeFile(PRIORITIES_FILE_PATH, JSON.stringify(priorities, null, 2)));
        }
        await Promise.all(promises);
        res.status(200).json({ success: true, message: 'Sincronización completa.' });
    } catch (error) {
        console.error('Error en POST /api/sync_all:', error);
        res.status(500).json({ error: 'No se pudo sincronizar todos los archivos.' });
    }
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}`);
});