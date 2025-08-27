// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 🔥 Conecta a Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 📂 Ruta para guardar PDFs (si hicieras cache local)
const PDF_PATH = path.join(process.cwd(), 'public', 'pedidos-pdf');
if (!fs.existsSync(PDF_PATH)) fs.mkdirSync(PDF_PATH, { recursive: true });

/**
 * -----------------------------
 * 📦 GUARDAR PEDIDOS
 * -----------------------------
 */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
      return res.status(400).json({ error: 'Pedido inválido' });

    let total = 0;
    const items = [];

    for (const it of pedidoItems) {
      const prodId = it.id; // 🔥 Mantener string
      const { data: prod, error: prodError } = await supabase
        .from('productos')
        .select('*')
        .eq('id', prodId)
        .single();

      if (prodError) {
        console.warn('⚠️ Producto no encontrado o error:', prodError);
        continue;
      }
      if (!prod) continue;

      const cantidadFinal = Math.min(Number(it.cantidad) || 0, Number(prod.stock) || 0);
      if (cantidadFinal <= 0) continue;

      const precioUnitario = Number(it.precio ?? it.precio_unitario ?? prod.precio) || 0;
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
      const { error: updErr } = await supabase
        .from('productos')
        .update({ stock: newStock })
        .eq('id', prodId);
      if (updErr) console.error('❌ Error actualizando stock:', updErr);
    }

    if (items.length === 0) return res.status(400).json({ error: 'No hay items válidos para el pedido' });

    const id = Date.now().toString(); // 🔥 Usar string para IDs
    const payload = { id, user: usuarioPedido, fecha: new Date().toISOString(), items, total };

    console.log('💾 Guardando pedido:', payload);

    const { data, error } = await supabase.from('pedidos').insert([payload]).select().single();
    if (error) {
      console.error('❌ Supabase insert error:', error);
      return res.status(500).json({ error });
    }

    const returnedId = data?.id ?? id;

    // ⚠️ Simulamos PDF, pero realmente debería generarse
    const pdfUrl = `https://supabase.storage/pedidos-pdf/pedido_${returnedId}.pdf`;

    res.json({ ok: true, mensaje: 'Pedido guardado', id: returnedId, pdf: pdfUrl });
  } catch (err) {
    console.error('❌ Exception en guardar-pedidos:', err);
    res.status(500).json({ error: err.message || err });
  }
});

/**
 * -----------------------------
 * ❌ ELIMINAR PEDIDO
 * -----------------------------
 */
app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  try {
    const id = req.params.id; // 🔥 No convertir a Number
    console.log(`🗑️ Intentando eliminar pedido ID: ${id}`);

    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', id)
      .single();

    console.log('📦 Pedido encontrado:', pedido);

    if (pedidoError || !pedido) {
      console.error('❌ Pedido no encontrado:', pedidoError);
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 🔄 Restaurar stock
    for (const it of pedido.items || []) {
      const prodId = it.id;
      console.log(`🔄 Restaurando stock para producto ${prodId} (+${it.cantidad})`);

      const { data: prod } = await supabase
        .from('productos')
        .select('*')
        .eq('id', prodId)
        .single();

      if (prod) {
        const newStock = (Number(prod.stock) || 0) + (Number(it.cantidad) || 0);
        await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      }
    }

    // ❌ Borrar pedido de DB
    await supabase.from('pedidos').delete().eq('id', id);

    // 🗑️ Intentar borrar PDF en Supabase Storage
    const { error: delErr } = await supabase.storage
      .from('pedidos-pdf')
      .remove([`pedido_${id}.pdf`]);

    if (delErr) console.warn('⚠️ Error borrando PDF:', delErr);
    else console.log(`🗑️ PDF pedido_${id}.pdf eliminado de Supabase Storage`);

    res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado', pedidoId: id });
  } catch (err) {
    console.error('❌ Exception en eliminar-pedido:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});
