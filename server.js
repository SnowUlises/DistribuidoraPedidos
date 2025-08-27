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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ========================
        PRODUCTOS
======================== */
app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('productos').select('*');
    if (error) { console.error(error); return res.status(500).json({ error }); }
    res.json(data);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/productos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data, error } = await supabase.from('productos').select('*').eq('id', id).single();
    if (error) { console.error(error); return res.status(404).json({ error: 'Producto no encontrado' }); }
    res.json(data);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/productos', async (req, res) => {
  try {
    const { nombre, precio, categoria, stock } = req.body;
    const id = Date.now(); // numeric
    const payload = { id, nombre, precio, categoria, stock, imagen: `/imagenes/${id}.png` };
    const { data, error } = await supabase.from('productos').insert([payload]);
    if (error) { console.error(error); return res.status(500).json({ error }); }
    res.json(data[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/productos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data, error } = await supabase.from('productos').update(req.body).eq('id', id);
    if (error) { console.error(error); return res.status(404).json({ error: 'Producto no encontrado' }); }
    res.json(data[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/productos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error } = await supabase.from('productos').delete().eq('id', id);
    if (error) { console.error(error); return res.status(500).json({ error }); }
    res.status(204).end();
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/upload/:id', upload.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  res.json({ mensaje: 'Imagen subida' });
});

/* ========================
        PEDIDOS
======================== */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';

    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
      return res.status(400).json({ error: 'Pedido inválido' });

    let total = 0;
    const items = [];

    for (const it of pedidoItems) {
      const prodId = Number(it.id);
      const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();
      if (prodError) { console.warn('Producto no encontrado o error:', prodError); continue; }
      if (!prod) continue;

      const cantidadFinal = Math.min(Number(it.cantidad) || 0, Number(prod.stock) || 0);
      if (cantidadFinal <= 0) continue;

      const precioUnitario = Number(it.precio_unitario ?? prod.precio) || 0;
      const subtotal = cantidadFinal * precioUnitario;
      total += subtotal;

      items.push({
        id: prodId,
        nombre: prod.nombre,
        cantidad: cantidadFinal,
        precio_unitario: precioUnitario,
        subtotal
      });

      const newStock = (Number(prod.stock) || 0) - cantidadFinal;
      const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      if (updErr) console.error('Error actualizando stock:', updErr);
    }

    if (items.length === 0) return res.status(400).json({ error: 'No hay items válidos para el pedido' });

    const id = Date.now(); // numeric id
    // enviar items como JSON (supabase acepta objetos JS para json/jsonb)
    const payload = { id, user: usuarioPedido, fecha: new Date().toISOString(), items, total };
    const { data, error } = await supabase.from('pedidos').insert([payload]);
    if (error) { console.error(error); return res.status(500).json({ error }); }

    res.json({ ok: true, mensaje: 'Pedido guardado', id: data[0].id });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/pedidos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos').select('*');
    if (error) { console.error(error); return res.status(500).json({ error }); }
    const map = {};
    data.forEach(r => {
      const u = r.user || 'invitado';
      map[u] = map[u] || [];
      map[u].push(r);
    });
    res.json(map);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data: pedido, error: pedidoError } = await supabase.from('pedidos').select('*').eq('id', id).single();
    if (pedidoError) { console.error(pedidoError); return res.status(404).json({ error: 'Pedido no encontrado' }); }

    // restaurar stock
    for (const it of pedido.items || []) {
      const prodId = Number(it.id);
      const { data: prod, error: prodErr } = await supabase.from('productos').select('*').eq('id', prodId).single();
      if (prodErr || !prod) { if (prodErr) console.warn(prodErr); continue; }
      const newStock = (Number(prod.stock) || 0) + (Number(it.cantidad) || 0);
      const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      if (updErr) console.error('Error restaurando stock:', updErr);
    }

    const { error: deleteError } = await supabase.from('pedidos').delete().eq('id', id);
    if (deleteError) { console.error(deleteError); return res.status(500).json({ error: deleteError }); }
    res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado' });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Error interno' });
  }
});

/* ========================
        SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
