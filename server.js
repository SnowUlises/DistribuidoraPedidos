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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: {
    persistSession: true, // Guarda la sesión en LocalStorage
    autoRefreshToken: true, // 🔥 ESTO ES CLAVE: Renueva el token automáticamente
    detectSessionInUrl: true
  }
});

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

      const precioBase = Number(prod.precio) || 0;
      const precioUnitario = precioBase * 1.10;
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

            const precioBase = Number(prod.precio) || 0;
            const precioUnitario = precioBase * 1.10;
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














