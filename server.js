import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// --- IMPORTS PARA EL SCRAPER ---
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
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

/* ====================================================================================
   🕵️‍♂️ LÓGICA DE ACTUALIZACIÓN DE STOCK (MODO DIAGNÓSTICO)
   ==================================================================================== */

const URL_BASE_WEB = "https://cooperar-s-k.dongestion.com/ecommerce/products";
const MAX_PAGINAS = 100; 
const HEADERS_SCRAPER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
};

// --- Utilidades ---
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

// --- Scraper de Página Individual (Con Logs) ---
async function obtenerProductosPagina(numeroPagina, logs) {
    const url = `${URL_BASE_WEB}?page=${numeroPagina}`;
    try {
        const response = await axios.get(url, { headers: HEADERS_SCRAPER, timeout: 20000 });
        const html = response.data;
        
        // Regex ajustado
        const patron = /(?:window\.)?bk_products\s*=\s*(\[.*?\]);/s;
        const match = html.match(patron);

        if (match && match[1]) {
            const data = JSON.parse(match[1]);
            const items = data.map(p => ({
                sku: normalizeSku(p.sku || p.id),
                stock: safeFloat(p.qty_available),
                nombre: p.name // Solo para debug
            })).filter(item => item.sku !== "");
            
            return items;
        } else {
            // DEBUG: Si falla en página 1, guardamos un trozo del HTML para ver qué pasó
            if (numeroPagina === 1) {
                logs.push(`⚠️ ALERTA: No se encontró el patrón Regex en página 1.`);
                logs.push(`🔍 Muestra HTML (primeros 200 chars): ${html.substring(0, 200)}...`);
            }
            return [];
        }
    } catch (error) {
        logs.push(`❌ Error HTTP pág ${numeroPagina}: ${error.message}`);
        return [];
    }
}

// --- Función Principal (Devuelve Logs) ---
async function ejecutarActualizacionStock(modoTest = false) {
    const logs = [];
    logs.push(`[${new Date().toISOString()}] 🚀 Inicio proceso de actualización.`);

    // 1. LEEMOS TU DB
    const { data: productosDB, error } = await supabase
        .from('productos')
        .select('id, sku')
        .not('sku', 'is', null)
        .neq('sku', '');

    if (error) {
        logs.push(`❌ Error FATAL leyendo Supabase: ${error.message}`);
        return logs;
    }

    logs.push(`📊 Tu Base de Datos: ${productosDB.length} productos con SKU.`);
    if (productosDB.length > 0) {
        logs.push(`🔍 Ejemplo SKU local: '${productosDB[0].sku}'`);
    }

    const skusEnMiDB = new Set(productosDB.map(p => p.sku));
    
    // 2. SCRAPING EXTERNO
    let productosExternos = [];
    // Si es modo test, solo leemos 3 páginas para no esperar tanto
    const limitePaginas = modoTest ? 3 : MAX_PAGINAS; 
    
    logs.push(`🌍 Iniciando Scraping (Máx ${limitePaginas} páginas)...`);

    const LOTE_PAGINAS = 5; 
    for (let i = 1; i <= limitePaginas; i += LOTE_PAGINAS) {
        const promesas = [];
        for (let j = 0; j < LOTE_PAGINAS; j++) {
            const pag = i + j;
            if (pag > limitePaginas) break;
            promesas.push(obtenerProductosPagina(pag, logs));
        }

        const resultados = await Promise.all(promesas);
        let encontradosEnLote = 0;
        
        for (const res of resultados) {
            if (res.length > 0) {
                productosExternos.push(...res);
                encontradosEnLote += res.length;
            }
        }
        
        if (encontradosEnLote === 0) {
            logs.push(`⏹️ Fin del catálogo detectado o bloqueo en lote ${i}.`);
            break; 
        }
    }

    logs.push(`📦 Total productos encontrados en la web: ${productosExternos.length}`);
    if (productosExternos.length > 0) {
        logs.push(`🔍 Ejemplo SKU Web: '${productosExternos[0].sku}' - Stock: ${productosExternos[0].stock}`);
    }

    // 3. COMPARACIÓN
    const actualizaciones = productosExternos.filter(p => skusEnMiDB.has(p.sku));
    logs.push(`🎯 Coincidencias (Match) SKUs: ${actualizaciones.length}`);

    if (actualizaciones.length === 0) {
        logs.push("⚠️ CUIDADO: No hubo coincidencias. Revisa si los SKUs son idénticos.");
        if (productosExternos.length > 0 && productosDB.length > 0) {
             logs.push(`COMPARATIVA FALLIDA: Local '${productosDB[0].sku}' vs Web '${productosExternos[0].sku}'`);
        }
        return logs;
    }

    // 4. ACTUALIZACIÓN DB
    let actualizados = 0;
    let errores = 0;
    
    const updateOne = async (item) => {
        const { error: errUpdate } = await supabase
            .from('productos')
            .update({ stock_leo: item.stock }) 
            .eq('sku', item.sku);
            
        if (errUpdate) {
            errores++;
            // Loguear solo el primer error para no saturar
            if (errores === 1) logs.push(`❌ Error Update Supabase: ${errUpdate.message}`);
        }
        else actualizados++;
    };

    const CHUNK_SIZE = 20;
    for (let i = 0; i < actualizaciones.length; i += CHUNK_SIZE) {
        const chunk = actualizaciones.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(updateOne));
    }

    logs.push(`✅ FINALIZADO. OK: ${actualizados} | Errores: ${errores}`);
    return logs;
}

// --- CRON JOB (Silencioso en consola) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const logs = await ejecutarActualizacionStock(false);
        console.log(logs[logs.length - 1]); // Solo imprime la ultima linea
    } catch (error) {
        console.error("❌ Cron Job Error:", error);
    }
});

// --- 🔥 NUEVO ENDPOINT PARA FORZAR Y VER QUE PASA ---
app.get('/api/test-stock-update', async (req, res) => {
    try {
        // Ejecuta en modo test (solo 3 páginas para ser rápido)
        const logs = await ejecutarActualizacionStock(true);
        res.json({ 
            success: true, 
            mensaje: "Proceso de diagnóstico finalizado", 
            logs: logs 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ==================================================================================== */

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

    const { data: peticiones, error: errPet } = await supabase
      .from('Peticiones')
      .select('*')
      .eq('user_id', userId);
    if (errPet) throw errPet;

    const { data: pedidos, error: errPed } = await supabase
      .from('pedidos')
      .select('*')
      .eq('user_id', userId);
    if (errPed) throw errPed;

    const listaPeticiones = (peticiones || []).map(p => ({
      ...p, tipo: 'peticion', estado_etiqueta: '⏳ Pendiente', color_estado: '#FF9800'
    }));
    const listaPedidos = (pedidos || []).map(p => ({
      ...p, tipo: 'pedido', estado_etiqueta: '✅ Preparado', color_estado: '#4CAF50'
    }));

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
    
    const userId = req.body.user_id || null;
    const nombreNegocio = req.body.nombre_negocio || null;

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

      if (prodError) { console.warn('⚠️ Producto no encontrado:', prodError); continue; }
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

    const payload = { 
        id, 
        user: usuarioPedido, 
        fecha: fechaLocal, 
        items, 
        total,
        user_id: userId,            
        nombre_negocio: nombreNegocio 
    };

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
    res.json({ ok: true, mensaje: 'Pedido guardado', id: returnedId, endpoint_pdf: `/api/pedidos/${returnedId}/pdf` });
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
        let { nombre, telefono, items: pedidoItems, total: providedTotal, user_id, nombre_negocio } = req.body;
        
        if (nombre && nombre.startsWith('Nombre: ')) { nombre = nombre.slice('Nombre: '.length).trim(); }
        if (!nombre || !Array.isArray(pedidoItems) || pedidoItems.length === 0) { return res.status(400).json({ error: 'Petición inválida: nombre o items faltantes' }); }
    
        let total = 0;
        const processedItems = [];

        for (const it of pedidoItems) {
            const prodId = it.id;
            const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();
            if (prodError || !prod) continue;
            const cantidadFinal = Number(it.cantidad) || 0;
            if (cantidadFinal <= 0) continue;
            const precioBase = Number(prod.precio) || 0;
            const precioUnitario = precioBase * 1.10;
            const subtotal = cantidadFinal * precioUnitario;
            total += subtotal;
            processedItems.push({ id: prodId, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: precioUnitario, subtotal });
        }
    
        if (processedItems.length === 0) { return res.status(400).json({ error: 'No hay items válidos para la petición' }); }
    
        const totalInt = Math.round(total);
        const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

        const payload = {
            nombre,
            telefono: telefono || null,
            items: processedItems,
            total: totalInt,
            fecha: fechaLocal,
            user_id: user_id || null,              
            nombre_negocio: nombre_negocio || null 
        };
        
        console.log('💾 Guardando petición:', payload);
        const { data, error } = await supabase.from('Peticiones').insert([payload]).select().single();
    
        if (error) { console.error('❌ Supabase insert error:', error); return res.status(500).json({ error: `Error al guardar la petición: ${error.message}` }); }
        res.json({ ok: true, mensaje: 'Petición guardada', id: data?.id });
    } catch (err) {
        console.error('❌ Exception en Enviar-Peticion:', err);
        res.status(500).json({ error: err.message || 'Error interno del servidor' });
    }
});

app.get('/api/mi-estado-cuenta', async (req, res) => {
    try {
        const userId = req.query.uid;
        if (!userId) return res.status(400).json({ error: 'Usuario no identificado' });
        const { data, error } = await supabase.from('clients_v2').select('*').eq('user_id', userId).single();
        if (error || !data) { return res.status(404).json({ error: 'Cliente no vinculado' }); }
        const clienteLimpio = { name: data.name, items: data.data.items || [], history: data.data.history || [] };
        res.json(clienteLimpio);
    } catch (err) {
        console.error('❌ Error cargando cuenta:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});
