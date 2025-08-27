const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./tienda.db');
const productos = JSON.parse(fs.readFileSync('./productos.json', 'utf-8'));

db.serialize(() => {
  const stmt = db.prepare('INSERT INTO productos (nombre, precio, categoria, stock, imagen) VALUES (?, ?, ?, ?, ?)');
  productos.forEach(p => {
    stmt.run(p.nombre, p.precio, p.categoria, p.stock, p.imagen || '');
  });
  stmt.finalize();
});

db.close();
console.log('Productos migrados a tienda.db');
