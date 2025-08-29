const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const dbPath = path.join(__dirname, 'db');
const loadsPath = path.join(dbPath, 'loads.json');
const linesPath = path.join(dbPath, 'lines.json');
const prioritiesPath = path.join(dbPath, 'priorities.json');

const ensureDbDirectory = async () => {
    try {
        await fs.access(dbPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(dbPath);
        } else {
            throw error;
        }
    }
};

const readJsonFile = async (filePath) => {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {}; // Si el archivo no existe, devuelve un objeto vacío
        }
        throw error;
    }
};

const writeJsonFile = async (filePath, data) => {
    await ensureDbDirectory();
    await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Endpoints ---

// GET (Leer datos)
app.get('/api/orders', async (req, res) => {
    try {
        const data = await readJsonFile(path.join(dbPath, 'orders_flat.json'));
        res.json(data);
    } catch (error) {
        console.error('Error reading orders:', error);
        res.status(500).send('Error reading orders data');
    }
});

app.get('/api/loads', async (req, res) => res.json(await readJsonFile(loadsPath)));
app.get('/api/lines', async (req, res) => res.json(await readJsonFile(linesPath)));
app.get('/api/priorities', async (req, res) => res.json(await readJsonFile(prioritiesPath)));

// POST (Guardar datos)
app.post('/api/loads', async (req, res) => {
    try {
        const { updates } = req.body;
        const currentLoads = await readJsonFile(loadsPath);
        updates.forEach(({ orderId, load }) => {
            if (load) {
                currentLoads[orderId] = load;
            } else {
                delete currentLoads[orderId];
            }
        });
        await writeJsonFile(loadsPath, currentLoads);
        res.status(200).send('Loads updated');
    } catch (error) {
        console.error('Error writing loads:', error);
        res.status(500).send('Error updating loads');
    }
});

app.post('/api/lines', async (req, res) => {
    try {
        const { assignmentKey, line } = req.body;
        const currentLines = await readJsonFile(linesPath);
        if (line) {
            currentLines[assignmentKey] = line;
        } else {
            delete currentLines[assignmentKey];
        }
        await writeJsonFile(linesPath, currentLines);
        res.status(200).send('Lines updated');
    } catch (error) {
        console.error('Error writing lines:', error);
        res.status(500).send('Error updating lines');
    }
});

app.post('/api/priorities', async (req, res) => {
    try {
        await writeJsonFile(prioritiesPath, req.body);
        res.status(200).send('Priorities updated');
    } catch (error) {
        console.error('Error writing priorities:', error);
        res.status(500).send('Error updating priorities');
    }
});

app.post('/api/sync_all', async (req, res) => {
    try {
        const { lines, priorities } = req.body;
        if (lines) await writeJsonFile(linesPath, lines);
        if (priorities) await writeJsonFile(prioritiesPath, priorities);
        res.status(200).send('Sync complete');
    } catch (error) {
        console.error('Error during sync:', error);
        res.status(500).send('Error during sync');
    }
});


// --- INICIO DEL SERVIDOR (LA CORRECCIÓN CLAVE) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});