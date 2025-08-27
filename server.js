import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join('public')));
app.use('/imagenes', express.static(path.join('public', 'imagenes')));

const IMG_PATH = path.join('public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMG_PATH),
  filename: (req, file, cb) => cb(null, `${req.params.id}.png`)
});
const upload = multer({ storage });

// Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("❌ Debes definir SUPABASE_URL y SUPABASE_KEY en las variables de entorno");
  process.exit(1);
}
// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ========================
        PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  const { data, error } = await supabase.from('productos').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/api/productos/:id', async (req, res) => {
  const { data, error } = await supabase.from('productos').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(data);
});

app.post('/api/productos', async (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  const id = Date.now().toString();
  const { data, error } = await supabase.from('productos').insert([{ id, nombre, precio, categoria, stock, imagen: `/imagenes/${id}.png` }]);
  if (error) return res.status(500).json({ error });
  res.json(data[0]);
});

app.put('/api/productos/:id', async (req, res) => {
  const { data, error } = await supabase.from('productos').update(req.body).eq('id', req.params.id);
  if (error) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(data[0]);
});

app.delete('/api/productos/:id', async (req, res) => {
  const { error } = await supabase.from('productos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error });
  res.status(204).end();
});

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
    const { data: prod, error } = await supabase.from('productos').select('*').eq('id', Number(it.id)).single();
    if (!prod) continue;
    const cantidadFinal = Math.min(it.cantidad, prod.stock);
    const subtotal = cantidadFinal * it.precio_unitario; // usar precio del carrito
    total += subtotal;
    items.push({ id: it.id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: it.precio_unitario, subtotal });
    await supabase.from('productos').update({ stock: prod.stock - cantidadFinal }).eq('id', it.id);
  }

  const id = Date.now().toString();
  const { data, error } = await supabase.from('pedidos').insert([{ id, user: usuarioPedido, fecha: new Date(), items, total }]);
  if (error) return res.status(500).json({ error });
  res.json({ ok: true, mensaje: 'Pedido guardado', id: data[0].id });
});


app.get('/api/pedidos', async (req, res) => {
  const { data, error } = await supabase.from('pedidos').select('*');
  if (error) return res.status(500).json({ error });
  const map = {};
  data.forEach(r => {
    const u = r.user || 'invitado';
    map[u] = map[u] || [];
    map[u].push(r);
  });
  res.json(map);
});

app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  const { data: pedido, error: pedidoError } = await supabase.from('pedidos').select('*').eq('id', req.params.id).single();
  if (pedidoError) return res.status(404).json({ error: 'Pedido no encontrado' });

  for (const it of pedido.items) {
    const { data: prod } = await supabase.from('productos').select('*').eq('id', it.id).single();
    if (prod) await supabase.from('productos').update({ stock: prod.stock + it.cantidad }).eq('id', it.id);
  }

  const { error: deleteError } = await supabase.from('pedidos').delete().eq('id', req.params.id);
  if (deleteError) return res.status(500).json({ error: deleteError });
  res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado' });
});

/* ========================
        SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));




