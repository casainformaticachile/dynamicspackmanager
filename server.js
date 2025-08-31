import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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

// --- Rutas para archivos locales (Loads, Lines, Priorities, Passwords) ---
const LOADS_FILE_PATH = path.join(__dirname, 'loads.json');
const LINES_FILE_PATH = path.join(__dirname, 'lines.json');
const PRIORITIES_FILE_PATH = path.join(__dirname, 'priorities.json');
const PASSWORDS_FILE_PATH = path.join(__dirname, 'passwords.json'); // NUEVO ARCHIVO DE CLAVES

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

// --- NUEVA RUTA PARA VERIFICAR CONTRASEÑAS ---
app.post('/api/verify-password', async (req, res) => {
    const { type, password } = req.body;
    if (!type || !password) {
        return res.status(400).json({ success: false, message: 'Falta tipo o contraseña.' });
    }

    try {
        const passwords = await readJsonFile(PASSWORDS_FILE_PATH);
        if (passwords[type] && passwords[type] === password) {
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('Error verificando la contraseña:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});


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
    // Cambiamos "line" por "lines" para que quede claro que esperamos un array
    const { assignmentKey, lines } = req.body; 
    if (!assignmentKey) {
        return res.status(400).json({ error: 'Falta "assignmentKey" en la petición.' });
    }
    try {
        const allLinesData = await readJsonFile(LINES_FILE_PATH, {});
        // Si "lines" es un array con contenido, lo guardamos.
        // Si está vacío o no existe, eliminamos la clave para limpiar.
        if (lines && Array.isArray(lines) && lines.length > 0) {
            allLinesData[assignmentKey] = lines;
        } else {
            delete allLinesData[assignmentKey];
        }
        await fs.writeFile(LINES_FILE_PATH, JSON.stringify(allLinesData, null, 2));
        res.status(200).json({ success: true, message: 'Asignación de líneas actualizada.' });
    } catch (error) {
        console.error('Error en POST /api/lines:', error);
        res.status(500).json({ error: 'No se pudo guardar la asignación de líneas.' });
    }
});// --- NUEVAS RUTAS PARA PRIORITIES ---
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