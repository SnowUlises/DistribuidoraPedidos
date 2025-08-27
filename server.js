const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

const IMG_PATH = path.join(__dirname, 'public', 'imagenes');
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// SQLite
const db = new sqlite3.Database('./tienda.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    precio REAL,
    categoria TEXT,
    stock INTEGER,
    imagen TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    fecha TEXT,
    items TEXT, -- JSON string
    total REAL
  )`);
});

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', (req, res) => {
  db.all('SELECT * FROM productos', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/productos/:id', (req, res) => {
  db.get('SELECT * FROM productos WHERE id=?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(row);
  });
});

app.post('/api/productos', (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  db.run(
    'INSERT INTO productos (nombre, precio, categoria, stock, imagen) VALUES (?, ?, ?, ?, ?)',
    [nombre, precio, categoria, stock, `/imagenes/${Date.now()}.png`],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM productos WHERE id=?', [this.lastID], (err,row)=>res.json(row));
    }
  );
});

app.put('/api/productos/:id', (req, res) => {
  const { nombre, precio, categoria, stock, imagen } = req.body;
  db.run(
    'UPDATE productos SET nombre=?, precio=?, categoria=?, stock=?, imagen=? WHERE id=?',
    [nombre, precio, categoria, stock, imagen, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM productos WHERE id=?', [req.params.id], (err,row)=>res.json(row));
    }
  );
});

app.delete('/api/productos/:id', (req, res) => {
  db.run('DELETE FROM productos WHERE id=?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(204).end();
  });
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
app.post('/api/guardar-pedidos', (req, res) => {
  const pedidoItems = req.body.pedido;
  const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
  if (!Array.isArray(pedidoItems) || pedidoItems.length === 0)
    return res.status(400).json({ error: 'Pedido inválido' });

  db.serialize(() => {
    let total = 0;
    const items = [];
    const updateStock = [];

    const placeholders = pedidoItems.map(it => '?').join(',');
    db.all(`SELECT * FROM productos WHERE id IN (${placeholders})`, pedidoItems.map(it=>it.id), (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      for (const it of pedidoItems) {
        const prod = rows.find(r=>r.id==it.id);
        if (!prod) continue;
        const cantidadFinal = Math.min(it.cantidad, prod.stock);
        total += cantidadFinal * prod.precio;
        items.push({ id: prod.id, nombre: prod.nombre, cantidad: cantidadFinal, precio_unitario: prod.precio });
        updateStock.push({ id: prod.id, stock: prod.stock - cantidadFinal });
      }

      const fecha = new Date().toISOString();
      db.run(
        'INSERT INTO pedidos (user, fecha, items, total) VALUES (?, ?, ?, ?)',
        [usuarioPedido, fecha, JSON.stringify(items), total],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });

          // actualizar stock
          const stmt = db.prepare('UPDATE productos SET stock=? WHERE id=?');
          updateStock.forEach(u => stmt.run(u.stock, u.id));
          stmt.finalize();

          res.json({ ok: true, mensaje: 'Pedido guardado', id: this.lastID });
        }
      );
    });
  });
});

app.get('/api/pedidos', (req,res)=>{
  db.all('SELECT * FROM pedidos', (err, rows)=>{
    if(err) return res.status(500).json({error: err.message});
    const map = {};
    rows.forEach(r=>{
      const u = r.user || 'invitado';
      map[u] = map[u]||[];
      map[u].push({ id:r.id, fecha:r.fecha, items: JSON.parse(r.items), total:r.total });
    });
    res.json(map);
  });
});

app.delete('/api/eliminar-pedido/:id', (req,res)=>{
  const id = req.params.id;
  db.get('SELECT * FROM pedidos WHERE id=?',[id],(err,row)=>{
    if(err) return res.status(500).json({error: err.message});
    if(!row) return res.status(404).json({error:'Pedido no encontrado'});

    const items = JSON.parse(row.items);
    // restaurar stock
    const stmt = db.prepare('UPDATE productos SET stock=stock+? WHERE id=?');
    items.forEach(it=>stmt.run(it.cantidad,it.id));
    stmt.finalize();

    // borrar pedido
    db.run('DELETE FROM pedidos WHERE id=?',[id], err=>{
      if(err) return res.status(500).json({error:err.message});
      res.json({ok:true, mensaje:'Pedido eliminado y stock restaurado'});
    });
  });
});

/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Servidor en puerto ${PORT}`));
