const express = require('express');
const app = express();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_PATH = './productos.json';
const PEDIDOS_PATH = path.join(__dirname, 'pedidos');

// Crear carpeta pedidos si no existe
if (!fs.existsSync(PEDIDOS_PATH)) {
  fs.mkdirSync(PEDIDOS_PATH);
}

let productos = [];
let nextId = 1;

if (fs.existsSync(DATA_PATH)) {
  productos = JSON.parse(fs.readFileSync(DATA_PATH));
  if (productos.length > 0) {
    nextId = Math.max(...productos.map(p => p.id)) + 1;
  }
}

function guardar() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(productos, null, 2));
}

// Rutas productos (sin cambios)
app.get('/api/productos', (req, res) => {
  res.json(productos);
});
app.get('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const producto = productos.find(p => p.id === id);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(producto);
});
app.post('/api/productos', (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  if (!nombre || precio == null) return res.status(400).json({ error: 'Datos incompletos' });
  const idActual = nextId++;
  const nuevo = { id: idActual, nombre, precio, categoria, stock, imagen: `/imagenes/${idActual}.jpg` };
  productos.push(nuevo);
  guardar();
  res.status(201).json(nuevo);
});
app.put('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = productos.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'No existe' });
  productos[index] = { ...productos[index], ...req.body };
  guardar();
  res.json(productos[index]);
});
app.delete('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = productos.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'No existe' });
  const rutaImg = path.join(__dirname, 'public', 'imagenes', `${id}.jpg`);
  if (fs.existsSync(rutaImg)) fs.unlinkSync(rutaImg);
  productos = productos.filter(p => p.id !== id);
  guardar();
  res.status(204).end();
});

// Multer config y rutas imagen (sin cambios)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'imagenes'));
  },
  filename: (req, file, cb) => {
    const id = req.params.id;
    cb(null, `${id}.jpg`);
  }
});
const upload = multer({ storage });
app.post('/api/upload/:id', upload.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  res.status(200).json({ mensaje: 'Imagen subida' });
});
app.delete('/api/upload/:id', (req, res) => {
  const id = req.params.id;
  const rutaImg = path.join(__dirname, 'public', 'imagenes', `${id}.jpg`);
  if (fs.existsSync(rutaImg)) {
    fs.unlinkSync(rutaImg);
    res.status(204).end();
  } else {
    res.status(404).json({ error: 'Imagen no encontrada' });
  }
});




// Guardar pedido como PDF
app.post('/api/guardar-pedido', (req, res) => {
  const { usuario, index, pedido, info } = req.body;
  if (!usuario || !Array.isArray(pedido)) return res.status(400).send('Datos inválidos');

  // === 1. Descontar stock ===
  let errorStock = false;
  pedido.forEach(item => {
    const producto = productos.find(p => p.id === item.id);
    if (!producto) {
      errorStock = true;
      return;
    }
    if (producto.stock !== undefined) {
      if (producto.stock < item.cantidad) {
        errorStock = true;
      } else {
        producto.stock -= item.cantidad;
      }
    }
  });

  if (errorStock) return res.status(400).send('Stock insuficiente');
  guardar(); // Guardar cambios en productos.json

  // === 2. Guardar pedido en JSON ===
  const pedidosJsonPath = path.join(PEDIDOS_PATH, 'pedidos.json');
  let pedidosGuardados = [];
  if (fs.existsSync(pedidosJsonPath)) {
    pedidosGuardados = JSON.parse(fs.readFileSync(pedidosJsonPath));
  }

  const nuevoPedido = {
    usuario,
    index,
    info,
    pedido,
    fecha: new Date().toISOString()
  };

  pedidosGuardados.push(nuevoPedido);
  fs.writeFileSync(pedidosJsonPath, JSON.stringify(pedidosGuardados, null, 2));

  // === 3. Generar PDF (igual que antes) ===
  const filePath = path.join(PEDIDOS_PATH, `${usuario}-${index}.pdf`);
  const doc = new PDFDocument({ size: [220, 600], margins: { top: 10, bottom: 10, left: 10, right: 10 } });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 60, 10, { width: 100 });
  }
  doc.moveDown(7);

  doc.font('Courier').fontSize(9);
  doc.text(`Usuario: ${usuario}`);
  doc.text(`Nombre: ${info?.nombre || ''} ${info?.apellido || ''}`);
  doc.text(`Teléfono: ${info?.telefono || ''}`);
  doc.text(`Email: ${info?.email || ''}`);

  doc.moveDown();
  const fecha = new Date();
  doc.text(`Fecha: ${fecha.toLocaleDateString()} ${fecha.toLocaleTimeString()}`, { align: 'center' });

  doc.moveDown(0.5);
  doc.moveTo(10, doc.y).lineTo(210, doc.y).stroke();

  doc.moveDown(0.5);
  doc.fontSize(10).text('PEDIDO', { underline: true, align: 'center' });
  doc.moveDown(0.5);

  let total = 0;
  pedido.forEach(p => {
    const subtotal = p.cantidad * p.precio;
    total += subtotal;
    doc.text(`${p.cantidad} x ${p.nombre}`, { continued: true });
    doc.text(` $${subtotal.toFixed(2)}`, { align: 'right' });
  });

  doc.moveDown(0.5);
  doc.moveTo(10, doc.y).lineTo(210, doc.y).stroke();

  doc.moveDown(0.5);
  doc.fontSize(14).text(`TOTAL: $${total.toFixed(2)}`, { align: 'center', bold: true });
  doc.end();

  stream.on('finish', () => res.send('Pedido guardado (JSON + PDF) y stock actualizado'));
  stream.on('error', err => {
    console.error(err);
    res.status(500).send('Error al guardar PDF');
  });
});




const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

