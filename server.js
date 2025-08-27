const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Low, JSONFile } = require('lowdb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const IMG_PATH = path.join(__dirname, 'public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// DB setup
const dbFile = path.join(__dirname, 'data/db.json');
const adapter = new JSONFile(dbFile);
const { Low, JSONFile } = require('lowdb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// archivo JSON
const file = path.join(__dirname, 'data', 'db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter);

// función para cargar DB
async function cargarDB() {
  await db.read();
  db.data ||= { productos: [], pedidos: [] };
}
cargarDB();

// vigilar cambios manuales en db.json
fs.watch(file, async (eventType) => {
  if (eventType === 'change') {
    console.log('db.json cambió, recargando...');
    await cargarDB();
  }
});

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  await db.read();
  res.json(Object.values(db.data.productos));
});

app.get('/api/productos/:id', async (req, res) => {
  await db.read();
  const prod = db.data.productos[req.params.id];
  if(!prod) return res.status(404).json({error:'Producto no encontrado'});
  res.json(prod);
});

app.post('/api/productos', async (req, res) => {
  await db.read();
  const { nombre, precio, categoria, stock } = req.body;
  const id = Date.now().toString();
  const prod = { id, nombre, precio, categoria, stock, imagen: `/imagenes/${id}.png` };
  db.data.productos[id] = prod;
  await db.write();
  res.json(prod);
});

app.put('/api/productos/:id', async (req, res) => {
  await db.read();
  const prod = db.data.productos[req.params.id];
  if(!prod) return res.status(404).json({error:'Producto no encontrado'});
  const actualizado = { ...prod, ...req.body };
  db.data.productos[req.params.id] = actualizado;
  await db.write();
  res.json(actualizado);
});

app.delete('/api/productos/:id', async (req, res) => {
  await db.read();
  delete db.data.productos[req.params.id];
  await db.write();
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
  await db.read();
  const pedidoItems = req.body.pedido;
  const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
  if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
    return res.status(400).json({ error: 'Pedido inválido' });

  let total = 0;
  const items = [];

  for(const it of pedidoItems){
    const prod = db.data.productos[it.id];
    if(!prod) continue;
    const cantidadFinal = Math.min(it.cantidad, prod.stock);
    total += cantidadFinal * prod.precio;
    items.push({ id: it.id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: prod.precio });
    prod.stock -= cantidadFinal;
  }

  const id = Date.now().toString();
  db.data.pedidos[id] = { id, user: usuarioPedido, fecha: new Date(), items, total };
  await db.write();
  res.json({ ok: true, mensaje: 'Pedido guardado', id });
});

app.get('/api/pedidos', async (req,res)=>{
  await db.read();
  const map = {};
  Object.values(db.data.pedidos).forEach(r=>{
    const u = r.user || 'invitado';
    map[u] = map[u]||[];
    map[u].push(r);
  });
  res.json(map);
});

app.delete('/api/eliminar-pedido/:id', async (req,res)=>{
  await db.read();
  const pedido = db.data.pedidos[req.params.id];
  if(!pedido) return res.status(404).json({error:'Pedido no encontrado'});

  for(const it of pedido.items){
    const prod = db.data.productos[it.id];
    if(prod){
      prod.stock += it.cantidad;
    }
  }
  delete db.data.pedidos[req.params.id];
  await db.write();
  res.json({ok:true, mensaje:'Pedido eliminado y stock restaurado'});
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Servidor en puerto ${PORT}`));

