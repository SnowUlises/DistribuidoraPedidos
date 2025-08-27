const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const IMG_PATH = path.join(__dirname, 'public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// MongoDB
mongoose.connect('TU_MONGODB_URI', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(()=>console.log('MongoDB conectado'))
  .catch(err=>console.error(err));

// Schemas
const productoSchema = new mongoose.Schema({
  nombre: String,
  precio: Number,
  categoria: String,
  stock: Number,
  imagen: String
});
const pedidoSchema = new mongoose.Schema({
  user: { type: String, default: 'invitado' },
  fecha: { type: Date, default: Date.now },
  items: Array,
  total: Number
});

const Producto = mongoose.model('Producto', productoSchema);
const Pedido = mongoose.model('Pedido', pedidoSchema);

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  const productos = await Producto.find();
  res.json(productos);
});

app.get('/api/productos/:id', async (req, res) => {
  const producto = await Producto.findById(req.params.id);
  if(!producto) return res.status(404).json({error:'Producto no encontrado'});
  res.json(producto);
});

app.post('/api/productos', async (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  const prod = new Producto({ nombre, precio, categoria, stock, imagen: `/imagenes/${Date.now()}.png` });
  await prod.save();
  res.json(prod);
});

app.put('/api/productos/:id', async (req, res) => {
  const prod = await Producto.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if(!prod) return res.status(404).json({error:'Producto no encontrado'});
  res.json(prod);
});

app.delete('/api/productos/:id', async (req, res) => {
  await Producto.findByIdAndDelete(req.params.id);
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

  for(const it of pedidoItems){
    const prod = await Producto.findById(it.id);
    if(!prod) continue;
    const cantidadFinal = Math.min(it.cantidad, prod.stock);
    total += cantidadFinal * prod.precio;
    items.push({ id: prod._id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: prod.precio });
    prod.stock -= cantidadFinal;
    await prod.save();
  }

  const pedido = new Pedido({ user: usuarioPedido, items, total });
  await pedido.save();
  res.json({ ok: true, mensaje: 'Pedido guardado', id: pedido._id });
});

app.get('/api/pedidos', async (req,res)=>{
  const pedidos = await Pedido.find();
  const map = {};
  pedidos.forEach(r=>{
    const u = r.user || 'invitado';
    map[u] = map[u]||[];
    map[u].push({ id:r._id, fecha:r.fecha, items: r.items, total:r.total });
  });
  res.json(map);
});

app.delete('/api/eliminar-pedido/:id', async (req,res)=>{
  const pedido = await Pedido.findById(req.params.id);
  if(!pedido) return res.status(404).json({error:'Pedido no encontrado'});

  for(const it of pedido.items){
    const prod = await Producto.findById(it.id);
    if(prod){
      prod.stock += it.cantidad;
      await prod.save();
    }
  }

  await Pedido.findByIdAndDelete(req.params.id);
  res.json({ok:true, mensaje:'Pedido eliminado y stock restaurado'});
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Servidor en puerto ${PORT}`));
