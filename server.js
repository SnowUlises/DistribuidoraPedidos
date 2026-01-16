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

// --- 🔑 CONFIGURACIÓN SUPABASE (FIX: CLAVES HARDCODED PARA EVITAR ERROR 401) ---
const SUPABASE_URL = 'https://slroycxifwezthdomkny.supabase.co';
// Usamos la Service Role Key para tener permisos completos en el servidor
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNscm95Y3hpZndlenRoZG9ta255Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjI3MjM0MiwiZXhwIjoyMDcxODQ4MzQyfQ.s7vfcg-sqZw-VxXUnOCyroi7oTyzfx0i4siNeDOW6lE';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false, // Importante: false en servidor
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

/* ====================================================================================
   🕵️‍♂️ LÓGICA DE ACTUALIZACIÓN DE STOCK
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
        
        const patron = /(?:window\.)?bk_products\s*=\s*(\[.*?\]);/s;
        const match = html.match(patron);

        if (match && match[1]) {
            const data = JSON.parse(match[1]);
            const items = data.map(p => ({
                sku: normalizeSku(p.sku || p.id),
                stock: safeFloat(p.qty_available),
                nombre: p.name 
            })).filter(item => item.sku !== "");
            
            return items;
        } else {
            if (numeroPagina === 1) {
                logs.push(`⚠️ ALERTA: No se encontró el patrón Regex en página 1.`);
            }
            return [];
        }
    } catch (error) {
        logs.push(`❌ Error HTTP pág ${numeroPagina}: ${error.message}`);
        return [];
    }
}

// --- Función Principal ---
async function ejecutarActualizacionStock(modoTest = false) {
    const logs = [];
    logs.push(`[${new Date().toISOString()}] 🚀 Inicio proceso de actualización.`);

    const { data: productosDB, error } = await supabase
        .from('productos')
        .select('id, sku')
        .not('sku', 'is', null);

    if (error) {
        logs.push(`❌ Error FATAL leyendo Supabase: ${error.message}`);
        return logs;
    }

    logs.push(`📊 Tu Base de Datos: ${productosDB.length} productos con SKU.`);
    const skusEnMiDB = new Set(productosDB.map(p => String(p.sku).trim()));
    
    let productosExternos = [];
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
        
        if (encontradosEnLote === 0) break; 
    }

    logs.push(`📦 Total productos encontrados en la web: ${productosExternos.length}`);

    const actualizaciones = productosExternos.filter(p => skusEnMiDB.has(String(p.sku)));
    logs.push(`🎯 Coincidencias (Match) SKUs: ${actualizaciones.length}`);

    if (actualizaciones.length === 0) return logs;

    let actualizados = 0;
    let errores = 0;
    
    const updateOne = async (item) => {
        const { error: errUpdate } = await supabase
            .from('productos')
            .update({ stock_leo: item.stock }) 
            .eq('sku', item.sku);
            
        if (errUpdate) errores++;
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

// --- CRON JOB ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const logs = await ejecutarActualizacionStock(false);
        console.log(logs[logs.length - 1]);
    } catch (error) {
        console.error("❌ Cron Job Error:", error);
    }
});

// --- ENDPOINTS DIAGNÓSTICO ---
app.get('/api/test-stock-update', async (req, res) => {
    try {
        const logs = await ejecutarActualizacionStock(true);
        res.json({ success: true, logs: logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/forzar-sync', async (req, res) => {
    try {
        const logs = await ejecutarActualizacionStock(false); 
        res.json({ success: true, logs: logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ====================================================================================
   📦 RUTAS API
   ==================================================================================== */

// --- 🔥 NUEVO: VERIFICAR STOCK (Necesario para el Carrito) ---
app.post('/api/verificar-stock', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'IDs inválidos' });

        const { data, error } = await supabase
            .from('productos')
            .select('id, nombre, stock, stock_leo')
            .in('id', ids);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('❌ Error verificando stock:', err);
        res.status(500).json({ error: 'Error interno verificando stock' });
    }
});

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

app.get('/api/mis-pedidos', async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: 'Falta User ID' });

    const { data: peticiones, error: errPet } = await supabase.from('Peticiones').select('*').eq('user_id', userId);
    if (errPet) throw errPet;

    const { data: pedidos, error: errPed } = await supabase.from('pedidos').select('*').eq('user_id', userId);
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

app.get('/api/pedidos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos').select('*').order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando pedidos:', err);
    res.status(500).json({ error: 'No se pudieron cargar pedidos' });
  }
});

app.get('/api/peticiones', async (req, res) => {
  try {
    const { data, error } = await supabase.from('Peticiones').select('*').order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando peticiones:', err);
    res.status(500).json({ error: 'No se pudieron cargar peticiones' });
  }
});

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
      const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();

      if (prodError) { console.warn('⚠️ Producto no encontrado:', prodError); continue; }
      if (!prod) continue;

      const cantidadFinal = Number(it.cantidad) || 0;
      const precioBase = Number(prod.precio) || 0;
      const precioUnitario = precioBase * 1.10 * 1.02;
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
      const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      if (updErr) console.error('❌ Error actualizando stock:', updErr);
    }

    if (items.length === 0) return res.status(400).json({ error: 'No hay items válidos' });

    const id = Date.now().toString();
    const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    const payload = { 
        id, user: usuarioPedido, fecha: fechaLocal, items, total,
        user_id: userId, nombre_negocio: nombreNegocio 
    };

    console.log('💾 Guardando pedido:', payload);

    const { data, error } = await supabase.from('pedidos').insert([payload]).select().single();

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

// REEMPLAZA ESTO EN TU server.js

app.post('/api/Enviar-Peticion', async (req, res) => {
    try {
        console.log('📦 Recibiendo pedido:', JSON.stringify(req.body, null, 2));
        let { nombre, telefono, items: pedidoItems, total: providedTotal, user_id, nombre_negocio } = req.body;
        
        if (nombre && nombre.startsWith('Nombre: ')) nombre = nombre.slice('Nombre: '.length).trim();
        if (!nombre || !Array.isArray(pedidoItems) || pedidoItems.length === 0) return res.status(400).json({ error: 'Petición inválida' });
        
        // 1. EXTRAER TODOS LOS IDs
        const ids = pedidoItems.map(i => i.id);

        // 2. UNA SOLA CONSULTA A LA BASE DE DATOS (Más rápido y seguro)
        const { data: productosDB, error: dbError } = await supabase
            .from('productos')
            .select('*')
            .in('id', ids);

        if (dbError) {
            console.error('❌ Error DB al buscar productos:', dbError);
            return res.status(500).json({ error: 'Error verificando productos en el servidor.' });
        }

        let total = 0;
        const processedItems = [];

        // 3. PROCESAR EN MEMORIA
        for (const it of pedidoItems) {
            // Buscamos el producto en el array que ya trajimos (no hacemos fetch de nuevo)
            const prod = productosDB.find(p => String(p.id) === String(it.id));

            if (!prod) {
                console.warn(`⚠️ Producto ID ${it.id} no encontrado en DB, se omitirá.`);
                // Opcional: Podrías lanzar error aquí si quieres ser estricto
                continue; 
            }
            
            const cantidadFinal = Number(it.cantidad) || 0;
            if (cantidadFinal <= 0) continue;
            
            const precioBase = Number(prod.precio) || 0;
            const precioUnitario = precioBase * 1.10 * 1.02;
            const subtotal = cantidadFinal * precioUnitario;
            total += subtotal;
            
            processedItems.push({ 
                id: prod.id, 
                nombre: prod.nombre, 
                cantidad: cantidadFinal, 
                precio_unitario: precioUnitario, 
                subtotal 
            });
        }
        
        if (processedItems.length === 0) return res.status(400).json({ error: 'No se pudieron procesar los items (Stock o ID inválido)' });
        
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
        
        console.log('💾 Guardando petición validada:', payload);
        const { data, error } = await supabase.from('Peticiones').insert([payload]).select().single();
        
        if (error) { console.error('❌ Error insert:', error); return res.status(500).json({ error: error.message }); }
        res.json({ ok: true, mensaje: 'Petición guardada', id: data?.id });

    } catch (err) {
        console.error('❌ Exception en Enviar-Peticion:', err);
        res.status(500).json({ error: err.message });
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


