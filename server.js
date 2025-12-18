import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
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
 📦 HISTORIAL DE USUARIO (NUEVO)
----------------------------- */
app.get('/api/mis-pedidos', async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: 'Falta User ID' });

    // 1. Buscar en Peticiones (Pendientes)
    const { data: peticiones, error: errPet } = await supabase
      .from('Peticiones')
      .select('*')
      .eq('user_id', userId);
    if (errPet) throw errPet;

    // 2. Buscar en Pedidos (Aprobados)
    const { data: pedidos, error: errPed } = await supabase
      .from('pedidos')
      .select('*')
      .eq('user_id', userId);
    if (errPed) throw errPed;

    // 3. Unificar y etiquetar
    const listaPeticiones = (peticiones || []).map(p => ({
      ...p, tipo: 'peticion', estado_etiqueta: '⏳ Pendiente', color_estado: '#FF9800'
    }));
    const listaPedidos = (pedidos || []).map(p => ({
      ...p, tipo: 'pedido', estado_etiqueta: '✅ Preparado', color_estado: '#4CAF50'
    }));

    // Ordenar por fecha (más reciente primero)
    const historial = [...listaPeticiones, ...listaPedidos].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json(historial);
  } catch (err) {
    console.error('❌ Error cargando historial:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

/* -----------------------------
 📦 LISTAR PEDIDOS (ADMIN)
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

app.get('/api/peticiones', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Peticiones')
      .select('*')
      .order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando peticiones:', err);
    res.status(500).json({ error: 'No se pudieron cargar peticiones' });
  }
});

app.get('/api/pedidos/:id/pdf', async (req, res) => {
  try {
    const pedidoId = req.params.id;

    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();
    if (pedidoErr || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Generar PDF
    const pdfBuffer = await generarPDF(pedido);

    // Subir a Storage
    const pdfFileName = `pedido_${pedidoId}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pedidos-pdf')
      .upload(pdfFileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadErr) return res.status(500).json({ error: 'No se pudo subir el PDF' });

    // Intentar URL pública
    const { data: publicUrlData } = supabase
      .storage
      .from('pedidos-pdf')
      .getPublicUrl(pdfFileName);

    let url = publicUrlData?.publicUrl;

    // Si el bucket es privado, generar URL firmada (1 hora)
    if (!url) {
      const { data: signed, error: signedErr } = await supabase
        .storage
        .from('pedidos-pdf')
        .createSignedUrl(pdfFileName, 60 * 60);
      if (signedErr) return res.status(500).json({ error: 'No se pudo obtener URL del PDF' });
      url = signed.signedUrl;
    }

    return res.json({ ok: true, pdf: url });
  } catch (err) {
    console.error('❌ PDF error:', err);
    res.status(500).json({ error: err.message || 'Error generando PDF' });
  }
});


/* -----------------------------
 📦 GUARDAR PEDIDOS
----------------------------- */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    
    // --- NUEVO: Recibimos ID y Negocio ---
    const userId = req.body.user_id || null;
    const nombreNegocio = req.body.nombre_negocio || null;
    // -------------------------------------

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

      const cantidadFinal = Number(it.cantidad) || 0;

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

      const newStock = Math.max(0, (Number(prod.stock) || 0) - cantidadFinal);
      const { error: updErr } = await supabase
        .from('productos')
        .update({ stock: newStock })
        .eq('id', prodId);
      if (updErr) console.error('❌ Error actualizando stock:', updErr);
    }

    if (items.length === 0)
      return res.status(400).json({ error: 'No hay items válidos para el pedido' });

    const id = Date.now().toString();
    const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    // --- MODIFICADO: Agregamos user_id y nombre_negocio al payload ---
    const payload = { 
        id, 
        user: usuarioPedido, 
        fecha: fechaLocal, 
        items, 
        total,
        user_id: userId,           
        nombre_negocio: nombreNegocio 
    };
    // ----------------------------------------------------------------

    console.log('💾 Guardando pedido:', payload);

    const { data, error } = await supabase
      .from('pedidos')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return res.status(500).json({ error });
    }

    const returnedId = data?.id ?? id;

    // 🔹 RESPUESTA SIMPLE: nada de PDFs aquí
    res.json({
      ok: true,
      mensaje: 'Pedido guardado',
      id: returnedId,
      endpoint_pdf: `/api/pedidos/${returnedId}/pdf` // opcional
    });
  } catch (err) {
    console.error('❌ Exception en guardar-pedidos:', err);
    res.status(500).json({ error: err.message || err });
  }
});

/* -----------------------------
 📦 ENVIAR PETICION (MODIFICADO: SIN TELÉFONO)
----------------------------- */
/* -----------------------------
 📦 ENVIAR PETICION (CORREGIDO: CON TELÉFONO)
----------------------------- */
app.post('/api/Enviar-Peticion', async (req, res) => {
    try {
        console.log('Received payload:', JSON.stringify(req.body, null, 2));
        
        // 1. AQUI AGREGAMOS 'telefono' para leerlo del frontend
        let { nombre, telefono, items: pedidoItems, total: providedTotal, user_id, nombre_negocio } = req.body;
        
        if (nombre && nombre.startsWith('Nombre: ')) {
            nombre = nombre.slice('Nombre: '.length).trim();
        }

        if (!nombre || !Array.isArray(pedidoItems) || pedidoItems.length === 0) {
            return res.status(400).json({ error: 'Petición inválida: nombre o items faltantes' });
        }

        let total = 0;
        const processedItems = [];

        // Process each item
        for (const it of pedidoItems) {
            const prodId = it.id;
            if (!prodId) continue;

            const { data: prod, error: prodError } = await supabase
                .from('productos')
                .select('*')
                .eq('id', prodId)
                .single();

            if (prodError || !prod) continue;

            const cantidadFinal = Number(it.cantidad) || 0;
            if (cantidadFinal <= 0) continue;

            const precioUnitario = Number(it.precio ?? prod.precio) || 0;
            const subtotal = cantidadFinal * precioUnitario;
            total += subtotal;

            processedItems.push({
                id: prodId,
                nombre: prod.nombre,
                cantidad: cantidadFinal,
                precio_unitario: precioUnitario,
                subtotal
            });
        }

        if (processedItems.length === 0) {
            return res.status(400).json({ error: 'No hay items válidos para la petición' });
        }

        const totalInt = Math.round(total);
        const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

        // 2. AQUI AGREGAMOS 'telefono' AL PAYLOAD PARA SUPABASE
        const payload = {
            nombre,
            telefono: telefono || null, // <--- AHORA SE GUARDA
            items: processedItems,
            total: totalInt,
            fecha: fechaLocal,
            user_id: user_id || null,              
            nombre_negocio: nombre_negocio || null 
        };
        
        console.log('💾 Guardando petición:', payload);

        const { data, error } = await supabase
            .from('Peticiones')
            .insert([payload])
            .select()
            .single();

        if (error) {
            console.error('❌ Supabase insert error:', error);
            return res.status(500).json({ error: `Error al guardar la petición: ${error.message}` });
        }

        const returnedId = data?.id;
        res.json({
            ok: true,
            mensaje: 'Petición guardada',
            id: returnedId
        });
    } catch (err) {
        console.error('❌ Exception en Enviar-Peticion:', err);
        res.status(500).json({ error: err.message || 'Error interno del servidor' });
    }
});


async function generarPDF(pedido) {
  return new Promise(async (resolve, reject) => {
    const items = Array.isArray(pedido.items) ? pedido.items : [];

    // 🔹 Calculadura dinámica basada en ítems
    const alturaCalculada = 300 + (items.length * 60); // 60px aprox. por ítem
    const altura = 862;     // Mínimo 400px

    const doc = new PDFDocument({
      size: [267, altura], // 🔥 Tamaño personalizado, ancho fijo, alto dinámico
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Logo from Supabase
    const { data: logoBlob, error: logoError } = await supabase.storage.from('imagenes').download('logo.png');
    if (logoError) {
      console.error('Error downloading logo:', logoError);
    } else {
      const logoBuffer = Buffer.from(await logoBlob.arrayBuffer());
      doc.image(logoBuffer, 100, 20, { width: 100 });
      doc.moveDown(8);
    }

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(16).text(`Distribuidora Funaz`, { align: 'center' });
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(14);
    doc.text(`Dirección: Calle Colon 1740 Norte`);
    doc.text(`Factura N°: ${pedido.id || ''}`);
    
    // --- NUEVO: Mostrar el negocio en el PDF ---
    if(pedido.nombre_negocio) {
        doc.text(`Negocio: ${pedido.nombre_negocio}`);
    }
    // -------------------------------------------
    
    doc.text(`Pedidos: 2645583761`);
    doc.text(`Consultas: 2645156933`);
    doc.moveDown(1.5);

    const fecha = new Date(pedido.fecha || Date.now());
    doc.fontSize(14).text(`Fecha: ${fecha.toLocaleDateString()} ${fecha.toLocaleTimeString()}`, { align: 'center' });
    doc.moveDown(1.5);
    doc.moveTo(20, doc.y).lineTo(280, doc.y).stroke();
    doc.moveDown(1.5);

    // Título
    doc.fontSize(18).font('Helvetica-Bold').text('PEDIDO', { underline: true, align: 'center' });
    doc.moveDown(2);

    // Ítems
    let total = 0;
    items.forEach(item => {
      const cant = Number(item.cantidad) || 0;
      const precio = Number(item.precio_unitario ?? item.precio) || 0;
      const subtotal = cant * precio;
      total += subtotal;

      doc.fontSize(14).font('Helvetica-Bold').text(`${item.nombre || ''}`);
      doc.font('Helvetica').fontSize(14);
      doc.text(`${cant} x $${precio.toFixed(2)}`, { continued: true });
      doc.text(` $${subtotal.toFixed(2)}`, { align: 'right' });
      doc.moveDown(1.2);
    });

    // Total
    doc.moveDown(2);
    doc.moveTo(20, doc.y).lineTo(280, doc.y).stroke();
    doc.moveDown(1.5);
    doc.fontSize(20).font('Helvetica-Bold').text(`TOTAL: $${total.toFixed(2)}`, { align: 'center' });

    doc.moveDown(3);
    doc.fontSize(14).text('¡Gracias por su compra!', { align: 'center' });

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


app.get('/api/mi-estado-cuenta', async (req, res) => {
    try {
        const userId = req.query.uid;
        if (!userId) return res.status(400).json({ error: 'Usuario no identificado' });

        const { data, error } = await supabase
            .from('clients_v2')
            .select('*')
            .eq('user_id', userId) 
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Cliente no vinculado' });
        }

        // AQUI ESTÁ EL CAMBIO: Enviamos 'history'
        const clienteLimpio = {
            name: data.name,
            items: data.data.items || [],
            history: data.data.history || [] // <--- AHORA SE ENVÍA ESTO
        };

        res.json(clienteLimpio);

    } catch (err) {
        console.error('❌ Error cargando cuenta:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ⚠️ PUERTO CONFIGURADO PARA RENDER
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});



