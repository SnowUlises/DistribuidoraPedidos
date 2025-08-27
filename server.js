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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PDF_PATH = path.join(process.cwd(), 'public', 'pedidos-pdf');
if (!fs.existsSync(PDF_PATH)) fs.mkdirSync(PDF_PATH, { recursive: true });

/* -----------------------------
 📦 LISTAR PRODUCTOS
----------------------------- */
app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('productos').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando productos:', err);
    res.status(500).json({ error: 'No se pudieron cargar productos' });
  }
});

/* -----------------------------
 📦 LISTAR PEDIDOS
----------------------------- */
app.get('/api/pedidos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando pedidos:', err);
    res.status(500).json({ error: 'No se pudieron cargar pedidos' });
  }
});

app.get('/api/pedidos/:id/pdf', async (req, res) => {
  try {
    const pedidoId = req.params.id;

    // 🔹 Buscar el pedido en Supabase
    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();

    if (pedidoErr || !pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 📄 Generar PDF
    const pdfBuffer = await generarPDF(pedido);

    // ☁️ Subir PDF a Supabase Storage
    const pdfFileName = `pedido_${pedidoId}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pedidos-pdf')
      .upload(pdfFileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadErr) {
      console.error('❌ Error subiendo PDF:', uploadErr);
      return res.status(500).json({ error: 'No se pudo subir el PDF' });
    }

    const { data: publicUrlData } = supabase
      .storage
      .from('pedidos-pdf')
      .getPublicUrl(pdfFileName);

    return res.json({ ok: true, pdf: publicUrlData?.publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});





/* -----------------------------
 📦 GUARDAR PEDIDOS
----------------------------- */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
      return res.status(400).json({ error: 'Pedido inválido' });

    let total = 0;
    const items = [];

    for (const it of pedidoItems) {
      const prodId = it.id;
      const { data: prod, error: prodError } = await supabase
        .from('productos')
        .select('*')
        .eq('id', prodId)
        .single();

      if (prodError) {
        console.warn('⚠️ Producto no encontrado:', prodError);
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

    const id = Date.now().toString();
    const payload = { id, user: usuarioPedido, fecha: new Date().toISOString(), items, total };

    console.log('💾 Guardando pedido:', payload);

    const { data, error } = await supabase.from('pedidos').insert([payload]).select().single();
    if (error) {
      console.error('❌ Supabase insert error:', error);
      return res.status(500).json({ error });
    }

    const returnedId = data?.id ?? id;
    const pdfUrl = `https://supabase.storage/pedidos-pdf/pedido_${returnedId}.pdf`;

    res.json({ ok: true, mensaje: 'Pedido guardado', id: returnedId, pdf: pdfUrl });
  } catch (err) {
    console.error('❌ Exception en guardar-pedidos:', err);
    res.status(500).json({ error: err.message || err });
  }
});

async function generarPDF(pedido) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Encabezado
    doc.fontSize(18).text(`Pedido #${pedido.id}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12)
      .text(`Cliente: ${pedido.user || ''}`)
      .text(`Fecha: ${new Date(pedido.fecha).toLocaleString('es-AR')}`);
    doc.moveDown();

    // Tabla simple
    doc.font('Helvetica-Bold');
    doc.text('Producto', 40, doc.y)
       .text('Cant.', 300, undefined, { width: 50, align: 'right' })
       .text('P.U.', 360, undefined, { width: 80, align: 'right' })
       .text('Subtotal', 450, undefined, { width: 100, align: 'right' });
    doc.moveDown(0.5);
    doc.font('Helvetica');

    const items = Array.isArray(pedido.items) ? pedido.items : [];
    items.forEach(it => {
      const cant = Number(it.cantidad ?? 0);
      const pu   = Number(it.precio_unitario ?? it.precio ?? 0);
      const sub  = cant * pu;

      doc.text(it.nombre ?? '', 40, doc.y)
         .text(String(cant), 300, undefined, { width: 50, align: 'right' })
         .text(pu.toFixed(2), 360, undefined, { width: 80, align: 'right' })
         .text(sub.toFixed(2), 450, undefined, { width: 100, align: 'right' });
    });

    // Total
    const totalCalc = items.reduce((a, it) =>
      a + Number(it.cantidad ?? 0) * Number(it.precio_unitario ?? it.precio ?? 0), 0);
    const total = Number(pedido.total ?? totalCalc);

    doc.moveDown();
    doc.font('Helvetica-Bold').text(`Total: $ ${total.toFixed(2)}`, { align: 'right' });

    doc.end();
  });
}

/* -----------------------------
 ❌ ELIMINAR PEDIDO
----------------------------- */
app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  try {
    const id = req.params.id;
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

    await supabase.from('pedidos').delete().eq('id', id);

    const { error: delErr } = await supabase.storage
      .from('pedidos-pdf')
      .remove([`pedido_${id}.pdf`]);

    if (delErr) console.warn('⚠️ Error borrando PDF:', delErr);
    else console.log(`🗑️ PDF pedido_${id}.pdf eliminado`);

    res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado', pedidoId: id });
  } catch (err) {
    console.error('❌ Exception en eliminar-pedido:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});

