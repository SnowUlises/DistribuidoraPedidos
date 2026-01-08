import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// --- NUEVOS IMPORTS PARA EL SCRAPER ---
import axios from 'axios';
import cron from 'node-cron';
// --------------------------------------

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

/* ====================================================================================
   🤖 LÓGICA DE ACTUALIZACIÓN DE STOCK ("STOCK LEO")
   Se ejecuta cada 10 minutos. No toca el stock real, solo 'stock_leo'.
   ==================================================================================== */

const URL_BASE_WEB = "https://cooperar-s-k.dongestion.com/ecommerce/products";
const MAX_PAGINAS = 100; 
const HEADERS_SCRAPER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
};

// --- Utilidades del Scraper ---
function normalizeSku(val) {
    if (!val) return "";
    let s = String(val).trim();
    if (s.endsWith(".0")) s = s.slice(0, -2);
    return s;
}

function safeFloat(val) {
    try {
        if (!val) return 0.0;
        return parseFloat(String(val).replace(',', '')) || 0.0;
    } catch (e) { return 0.0; }
}

// --- Obtener productos de una página específica ---
async function obtenerProductosPagina(numeroPagina) {
    const url = `${URL_BASE_WEB}?page=${numeroPagina}`;
    try {
        const response = await axios.get(url, { headers: HEADERS_SCRAPER, timeout: 20000 });
        const html = response.data;
        const patron = /(?:window\.)?bk_products\s*=\s*(\[.*?\]);/s;
        const match = html.match(patron);

        if (match && match[1]) {
            const data = JSON.parse(match[1]);
            return data.map(p => ({
                sku: normalizeSku(p.sku || p.id),
                stock: safeFloat(p.qty_available)
            })).filter(item => item.sku !== "");
        }
        return [];
    } catch (error) {
        console.error(`⚠️ Error scrapeando pág ${numeroPagina}: ${error.message}`);
        return [];
    }
}

// --- Función Principal de Actualización ---
async function ejecutarActualizacionStock() {
    console.log(`[${new Date().toISOString()}] 🔄 Iniciando actualización de Stock Leo...`);

    // 1. LEEMOS TU DB (Solo lectura de IDs y SKUs para filtrar)
    const { data: productosDB, error } = await supabase
        .from('productos')
        .select('id, sku')
        .not('sku', 'is', null)
        .neq('sku', '');

    if (error) {
        console.error("❌ Error leyendo Supabase para actualización:", error);
        return;
    }

    const skusEnMiDB = new Set(productosDB.map(p => p.sku));
    
    // 2. SCRAPING EXTERNO (Lote por lote)
    let productosExternos = [];
    const LOTE_PAGINAS = 10; 
    
    for (let i = 1; i <= MAX_PAGINAS; i += LOTE_PAGINAS) {
        const promesas = [];
        for (let j = 0; j < LOTE_PAGINAS; j++) {
            const pag = i + j;
            if (pag > MAX_PAGINAS) break;
            promesas.push(obtenerProductosPagina(pag));
        }

        const resultados = await Promise.all(promesas);
        let encontradosEnLote = 0;
        
        for (const res of resultados) {
            if (res.length > 0) {
                productosExternos.push(...res);
                encontradosEnLote += res.length;
            }
        }
        if (encontradosEnLote === 0) break; 
    }

    // 3. FILTRADO (Solo actualizamos lo que existe en tu DB)
    const actualizaciones = productosExternos.filter(p => skusEnMiDB.has(p.sku));
    
    if (actualizaciones.length === 0) {
        console.log("✅ Nada que actualizar.");
        return;
    }

    // 4. ACTUALIZACIÓN MASIVA (Solo columna stock_leo)
    let actualizados = 0;
    let errores = 0;
    
    const updateOne = async (item) => {
        const { error: errUpdate } = await supabase
            .from('productos')
            .update({ stock_leo: item.stock }) // <--- SEGURIDAD: Solo tocamos stock_leo
            .eq('sku', item.sku);
            
        if (errUpdate) errores++;
        else actualizados++;
    };

    const CHUNK_SIZE = 20;
    for (let i = 0; i < actualizaciones.length; i += CHUNK_SIZE) {
        const chunk = actualizaciones.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(updateOne));
    }

    console.log(`✅ [FIN] Stock Leo Actualizado. Items: ${actualizados} | Errores: ${errores}`);
}

// --- CRON JOB (Cada 10 minutos) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        await ejecutarActualizacionStock();
    } catch (error) {
        console.error("❌ Error en tarea programada de stock:", error);
    }
});

/* ====================================================================================
   📦 FIN LÓGICA DE ACTUALIZACIÓN
   ==================================================================================== */


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
