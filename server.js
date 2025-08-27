import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const IMG_PATH = path.join(__dirname, 'public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// --- DB setup ---
const productosAdapter = new JSONFile(path.join(__dirname, 'productos.json'));
const productosDb = new Low(productosAdapter);
await productosDb.read();
productosDb.data ||= { productos: {} };

const pedidosAdapter = new JSONFile(path.join(__dirname, 'pedidos.json'));
const pedidosDb = new Low(pedidosAdapter);
await pedidosDb.read();
pedidosDb.data ||= { pedidos: {} };

// Vigilar cambios manuales
fs.watch(path.join(__dirname, 'productos.json'), async () => {
  await productosDb.read();
  productosDb.data ||= { productos: {} };
  console.log('productos.json recargado');
});
fs.watch(path.join(__dirname, 'pedidos.json'), async () => {
  await pedidosDb.read();
  pedidosDb.data ||= { pedidos: {} };
  console.log('pedidos.json recargado');
});

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  await productosDb.read();
  res.json(Object.values(productosDb.data.productos));
});

app.get('/api/productos/:id', async (req, res) => {
  await productosDb.read();
  const prod = productosDb.data.productos[req.params.id];
  if(!prod) return res.status(404).json({error:'Producto no encontrado'});
  res.json(prod);
});

app.post('/api/productos', async (req, res) => {
  await productosDb.read();
  const { nombre, precio, categoria, stock } = req.body;
  const id = Date.now().toString();
  const prod = { id, nombre, precio, categoria, stock, imagen: `/imagenes/${id}.png` };
  productosDb.data.productos[id] = prod;
  await productosDb.write();
  res.json(prod);
});

app.put('/api/productos/:id', async (req, res) => {
  await productosDb.read();
  const prod = productosDb.data.productos[req.params.id];
  if(!prod) return res.status(404).json({error:'Producto no encontrado'});
  const actualizado = { ...prod, ...req.body };
  productosDb.data.productos[req.params.id] = actualizado;
  await productosDb.write();
  res.json(actualizado);
});

app.delete('/api/productos/:id', async (req, res) => {
  await productosDb.read();
  delete productosDb.data.productos[req.params.id];
  await productosDb.write();
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
  await productosDb.read();
  await pedidosDb.read();
  const pedidoItems = req.body.pedido;
  const usuarioPedido = req.body.user || 'invitado';
  if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
    return res.status(400).json({ error: 'Pedido inválido' });

  let total = 0;
  const items = [];

  for(const it of pedidoItems){
    const prod = productosDb.data.productos[it.id];
    if(!prod) continue;
    const cantidadFinal = Math.min(it.cantidad, prod.stock);
    total += cantidadFinal * prod.precio;
    items.push({ id: it.id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: prod.precio });
    prod.stock -= cantidadFinal;
  }

  const id = Date.now().toString();
  pedidosDb.data.pedidos[id] = { id, user: usuarioPedido, fecha: new Date(), items, total };
  await productosDb.write();
  await pedidosDb.write();
  res.json({ ok: true, mensaje: 'Pedido guardado', id });
});

app.get('/api/pedidos', async (req,res)=>{
  await pedidosDb.read();
  const map = {};
  Object.values(pedidosDb.data.pedidos).forEach(r=>{
    const u = r.user || 'invitado';
    map[u] = map[u]||[];
    map[u].push(r);
  });
  res.json(map);
});

app.delete('/api/eliminar-pedido/:id', async (req,res)=>{
  await productosDb.read();
  await pedidosDb.read();
  const pedido = pedidosDb.data.pedidos[req.params.id];
  if(!pedido) return res.status(404).json({error:'Pedido no encontrado'});

  for(const it of pedido.items){
    const prod = productosDb.data.productos[it.id];
    if(prod) prod.stock += it.cantidad;
  }
  delete pedidosDb.data.pedidos[req.params.id];
  await productosDb.write();
  await pedidosDb.write();
  res.json({ok:true, mensaje:'Pedido eliminado y stock restaurado'});
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Servidor en puerto ${PORT}`));

