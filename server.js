const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const simpleGit = require('simple-git');
const git = simpleGit();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const DATA_FILE = path.join(__dirname, 'productos.json');
const PEDIDOS_FILE = path.join(__dirname, 'pedidos.json');
const IMG_PATH = path.join(__dirname, 'public', 'imagenes');

// Crear carpeta de imágenes si no existe
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// Cargar productos
let productos = [];
let nextId = 1;
if (fs.existsSync(DATA_FILE)) {
  productos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (productos.length > 0) nextId = Math.max(...productos.map(p => p.id)) + 1;
}

// Guardar productos en JSON
function guardarProductos() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(productos, null, 2));
  } catch (err) {
    console.error("Error al guardar productos:", err);
  }
}

// Git push
const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // crea un token en GitHub con repo scope
const REPO_OWNER = 'SnowUlises';
const REPO_NAME = 'DistribuidoraFunaz';
const BRANCH = 'main';

async function gitPushCambios(nombreArchivo) {
  try {
    const contenido = fs.readFileSync(nombreArchivo, 'utf8');
    const pathEnRepo = nombreArchivo;

    await axios.put(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${pathEnRepo}`,
      {
        message: `Actualización de ${nombreArchivo} ${new Date().toLocaleString()}`,
        content: Buffer.from(contenido).toString('base64'),
        branch: BRANCH
        // SHA eliminado
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log(`${nombreArchivo} subido a GitHub ✅`);
  } catch (err) {
    console.error(`Error subiendo ${nombreArchivo} a GitHub:`, err.response?.data || err.message);
  }
}


// Uso:
async function pushProductosYPedidos() {
  await gitPushCambios('productos.json')
  await gitPushCambios('pedidos.json')
}


/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', (req, res) => res.json(productos));

app.get('/api/productos/:id', (req, res) => {
  const producto = productos.find(p => p.id === Number(req.params.id));
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(producto);
});

app.post('/api/productos', (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  if (!nombre || precio == null) return res.status(400).json({ error: 'Datos incompletos' });
  const nuevo = { id: nextId++, nombre, precio, categoria, stock, imagen: `/imagenes/${nextId-1}.png` };
  productos.push(nuevo);
  guardarProductos();
  res.status(201).json(nuevo);
});

app.put('/api/productos/:id', (req, res) => {
  const index = productos.findIndex(p => p.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'No existe' });
  productos[index] = { ...productos[index], ...req.body };
  guardarProductos();
  res.json(productos[index]);
});

app.delete('/api/productos/:id', (req, res) => {
  const id = Number(req.params.id);
  productos = productos.filter(p => p.id !== id);
  const rutaImg = path.join(IMG_PATH, `${id}.png`);
  if (fs.existsSync(rutaImg)) fs.unlinkSync(rutaImg);
  guardarProductos();
  res.status(204).end();
});

/* ========================
     UPLOAD DE IMÁGENES
======================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMG_PATH),
  filename: (req, file, cb) => cb(null, `${req.params.id}.png`)
});
const upload = multer({ storage });
app.post('/api/upload/:id', upload.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  res.json({ mensaje: 'Imagen subida' });
});
app.delete('/api/upload/:id', (req, res) => {
  const rutaImg = path.join(IMG_PATH, `${req.params.id}.png`);
  if (fs.existsSync(rutaImg)) fs.unlinkSync(rutaImg);
  res.status(204).end();
});

/* ========================
     GUARDAR PEDIDOS
======================== */
app.post('/api/guardar-pedidos', (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';

    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }

    const orden = { user: usuarioPedido, fecha: new Date().toISOString(), items: [], total: 0 };

    for (const it of pedidoItems) {
      const id = Number(it.id);
      const cantidad = Number(it.cantidad) || 0;
      if (!id || cantidad <= 0) continue;

      const producto = productos.find(p => p.id === id);
      if (!producto) continue;

      const cantidadFinal = Math.min(cantidad, producto.stock || 0);
      producto.stock = Math.max(0, (producto.stock || 0) - cantidadFinal);

      const precioUnitario = Number(producto.precio || 0);
      const subtotal = precioUnitario * cantidadFinal;

      orden.items.push({ id, nombre: producto.nombre, cantidad: cantidadFinal, precio_unitario: precioUnitario, subtotal });
      orden.total += subtotal;
    }

    guardarProductos(); // actualizar stock
    let pedidosArr = [];
    if (fs.existsSync(PEDIDOS_FILE)) {
      const raw = fs.readFileSync(PEDIDOS_FILE, 'utf8');
      pedidosArr = raw ? JSON.parse(raw) : [];
    }

    pedidosArr.push(orden);
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosArr, null, 2));

    gitPushCambios('productos.json');
    gitPushCambios('pedidos.json'); 

    res.status(200).json({ ok: true, mensaje: 'Pedido guardado correctamente' });
  } catch (err) {
    console.error('Error guardando pedido:', err);
    res.status(500).json({ error: 'Error interno al guardar pedido' });
  }
});

/* ========================
     OBTENER PEDIDOS
======================== */
app.get('/api/pedidos', (req, res) => {
  try {
    if (!fs.existsSync(PEDIDOS_FILE)) return res.json({});
    const arr = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8') || '[]');
    const map = {};
    for (const orden of arr) {
      const u = orden.user || 'invitado';
      if (!map[u]) map[u] = [];
      map[u].push(orden.items.map(it => ({ id: it.id, nombre: it.nombre, cantidad: it.cantidad, precio: it.precio_unitario })));
    }
    res.json(map);
  } catch (err) {
    console.error(err);
    res.status(500).json({});
  }
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));






