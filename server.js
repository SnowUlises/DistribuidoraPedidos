const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Database } = require('instantdb'); // ya instalado
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const IMG_PATH = path.join(__dirname, 'public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// InstantDB
const db = new Database({ dir: './data' });

// === Cargar productos iniciales desde JSON si no hay nada ===
(async () => {
  const prods = await db.get('productos') || {};
  if (Object.keys(prods).length === 0) {
    const dataPath = path.join(__dirname, 'productos.json');
    if (fs.existsSync(dataPath)) {
      const json = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      for (const item of json) {
        const id = item.id || Date.now().toString();
        await db.set(`productos/${id}`, item);
      }
      console.log('Productos cargados desde productos.json');
    }
  }

  const ped = await db.get('pedidos') || {};
  if (Object.keys(ped).length === 0) {
    const dataPath = path.join(__dirname, 'pedidos.json');
    if (fs.existsSync(dataPath)) {
      const json = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      for (const item of json) {
        const id = item.id || Date.now().toString();
        await db.set(`pedidos/${id}`, item);
      }
      console.log('Pedidos cargados desde pedidos.json');
    }
  }
})();

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  const prods = await db.get('productos') || {};
  res.json(Object.entries(prods).map(([id, p]) => ({ id, ...p })));
});

app.get('/api/productos/:id', async (req, res) => {
  const prod = await db.get(`productos/${req.params.id}`);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(prod);
});

app.post('/api/productos', async (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  const id = Date.now().toString();
  const prod = { nombre, precio, categoria, stock, imagen: `/imagenes/${id}.png` };
  await db.set(`productos/${id}`, prod);
  res.json({ id, ...prod });
});

app.put('/api/productos/:id', async (req, res) => {
  const prod = await db.get(`productos/${req.params.id}`);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const actualizado = { ...prod, ...req.body };
  await db.set(`productos/${req.params.id}`, actualizado);
  res.json(actualizado);
});

app.delete('/api/productos/:id', async (req, res) => {
  await db.delete(`productos/${req.params.id}`);
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

/* ========================
          PEDIDOS
======================== */
app.post('/api/guardar-pedidos', async (req, res) => {
  const pedidoItems = req.body.pedido;
  const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
  if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
    return res.status(400).json({ error: 'Pedido inválido' });

  let total = 0;
  const items = [];

  for (const it of pedidoItems) {
    const prod = await db.get(`productos/${it.id}`);
    if (!prod) continue;
    const cantidadFinal = Math.min(it.cantidad, prod.stock);
    total += cantidadFinal * prod.precio;
    items.push({ id: it.id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: prod.precio });
    prod.stock -= cantidadFinal;
    await db.set(`productos/${it.id}`, prod);
  }

  const id = Date.now().toString();
  const pedido = { user: usuarioPedido, fecha: new Date(), items, total };
  await db.set(`pedidos/${id}`, pedido);
  res.json({ ok: true, mensaje: 'Pedido guardado', id });
});

app.get('/api/pedidos', async (req, res) => {
  const all = await db.get('pedidos') || {};
  const map = {};
  for (const [id, r] of Object.entries(all)) {
    const u = r.user || 'invitado';
    map[u] = map[u] || [];
    map[u].push({ id, fecha: r.fecha, items: r.items, total: r.total });
  }
  res.json(map);
});

app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  const pedido = await db.get(`pedidos/${req.params.id}`);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

  for (const it of pedido.items) {
    const prod = await db.get(`productos/${it.id}`);
    if (prod) {
      prod.stock += it.cantidad;
      await db.set(`productos/${it.id}`, prod);
    }
  }

  await db.delete(`pedidos/${req.params.id}`);
  res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado' });
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
